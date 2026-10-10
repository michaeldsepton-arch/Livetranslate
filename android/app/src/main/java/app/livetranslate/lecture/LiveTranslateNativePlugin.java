package app.livetranslate.lecture;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Small native helpers the web layer cannot do itself:
 *  - keepAwake:    keep the screen on while a lecture is being recorded
 *  - saveTextFile: write a transcript to Downloads/Lisan (no storage permission needed, Android 10+)
 *  - http:         fallback HTTPS client used only if the WebView blocks a request to the speech/translation APIs
 *  - startListening / stopListening: foreground service ("Lisan is listening") so Android lets the
 *                  microphone and network keep working with the screen off or another app in front
 */
@CapacitorPlugin(
    name = "LiveTranslateNative",
    permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})}
)
public class LiveTranslateNativePlugin extends Plugin {

    private static final String[] ALLOWED_HOSTS = {"api.groq.com", "generativelanguage.googleapis.com", "api.openai.com"};

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            if (enabled) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        JSObject res = new JSObject();
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), ListeningService.class));
            // keep the web page's renderer at full priority even while the app is not on screen
            getActivity().runOnUiThread(() -> {
                try {
                    getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
                } catch (Exception ignored) {
                }
            });
            res.put("ok", true);
        } catch (Exception e) {
            res.put("ok", false);
            res.put("reason", String.valueOf(e.getMessage()));
        }
        call.resolve(res);
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), ListeningService.class));
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    /** Android 13+ asks before an app may show the "listening" notification (the service runs either way). */
    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsResult");
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void saveTextFile(PluginCall call) {
        String filename = call.getString("filename");
        String text = call.getString("text");
        String mime = call.getString("mimeType", "text/plain");
        if (filename == null || text == null) {
            call.reject("filename and text are required");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("unsupported on this Android version");
            return;
        }
        try {
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Lisan");
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("could not create the file");
                return;
            }
            try (OutputStream os = resolver.openOutputStream(uri)) {
                if (os == null) {
                    call.reject("could not open the file");
                    return;
                }
                os.write(text.getBytes(StandardCharsets.UTF_8));
            }
            JSObject res = new JSObject();
            res.put("uri", uri.toString());
            res.put("path", "Downloads/Lisan/" + filename);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("save failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void http(PluginCall call) {
        String urlStr = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers");
        String bodyBase64 = call.getString("bodyBase64", "");
        Integer timeoutMs = call.getInt("timeoutMs", 60000);

        if (urlStr == null || !isAllowed(urlStr)) {
            call.reject("request not allowed");
            return;
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(timeoutMs == null ? 60000 : timeoutMs);
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    String v = headers.getString(k);
                    if (v != null) conn.setRequestProperty(k, v);
                }
            }
            if (bodyBase64 != null && !bodyBase64.isEmpty()) {
                byte[] body = Base64.decode(bodyBase64, Base64.DEFAULT);
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body);
                }
            }
            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = "";
            if (is != null) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                is.close();
                text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            }
            JSObject resHeaders = new JSObject();
            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty()) {
                    resHeaders.put(e.getKey().toLowerCase(), e.getValue().get(0));
                }
            }
            JSObject res = new JSObject();
            res.put("status", code);
            res.put("bodyText", text);
            res.put("headers", resHeaders);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("network error: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static boolean isAllowed(String urlStr) {
        try {
            URL u = new URL(urlStr);
            if (!"https".equals(u.getProtocol())) return false;
            for (String h : ALLOWED_HOSTS) if (h.equalsIgnoreCase(u.getHost())) return true;
        } catch (Exception ignored) {
        }
        return false;
    }
}
