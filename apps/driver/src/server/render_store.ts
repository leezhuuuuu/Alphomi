export type RenderDoc = {
  id: string;
  title: string;
  markdown: string;
  html: string;
  theme?: 'light' | 'dark' | 'system';
  createdAt: number;
};

const RENDER_DOCS = new Map<string, RenderDoc>();
const MAX_DOCS = 200;

const cleanupIfNeeded = () => {
  if (RENDER_DOCS.size <= MAX_DOCS) return;
  const entries = Array.from(RENDER_DOCS.values()).sort((a, b) => a.createdAt - b.createdAt);
  const toDelete = entries.slice(0, Math.max(0, entries.length - MAX_DOCS));
  toDelete.forEach((doc) => RENDER_DOCS.delete(doc.id));
};

export const setRenderDoc = (doc: RenderDoc): void => {
  RENDER_DOCS.set(doc.id, doc);
  cleanupIfNeeded();
};

export const getRenderDoc = (id: string): RenderDoc | undefined => RENDER_DOCS.get(id);
