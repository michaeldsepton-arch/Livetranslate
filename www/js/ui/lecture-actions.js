// Deleting lectures, with an Undo.  Used by the Library list and by the reader.
import { toast, confirmSheet } from "./overlay.js";

const shortTitle = (t) => (t.length > 34 ? t.slice(0, 33) + "…" : t);

/**
 * Delete one or more saved lectures.  Resolves true when something was deleted.
 * @param {object[]} items full session records
 * @param {{confirmMany?:boolean, onChange?:()=>void}} opts
 */
export async function deleteLectures(app, items, { confirmMany = true, onChange = () => {} } = {}) {
  const deletable = items.filter((s) => !(app.active && app.session && app.session.id === s.id));
  if (deletable.length < items.length) toast("A lecture that is still recording can't be deleted.", { kind: "warn" });
  if (!deletable.length) return false;

  if (confirmMany && deletable.length > 1) {
    const ok = await confirmSheet({
      title: `Delete ${deletable.length} lectures?`,
      text: "They will be removed from this phone. Text files you already saved or shared are not affected. You can undo for a few seconds.",
      confirm: `Delete ${deletable.length}`,
      danger: true,
    });
    if (!ok) return false;
  }

  for (const s of deletable) await app.store.remove(s.id);
  onChange();
  toast(deletable.length === 1 ? `Deleted “${shortTitle(deletable[0].title)}”` : `Deleted ${deletable.length} lectures`, {
    ms: 8000,
    action: "Undo",
    onAction: async () => {
      for (const s of deletable) await app.store.save(s);
      onChange();
    },
  });
  return true;
}
