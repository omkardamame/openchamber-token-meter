// One tiny element helper for both frames. A guest bundle has no framework:
// every node is made by hand, and this is the only shape it needs.

export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
