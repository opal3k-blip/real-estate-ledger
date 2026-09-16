function onDocumentWritten(path, handler) {
  const wrapped = async (event) => handler(event);
  wrapped.__isTrigger = true;
  wrapped.__handler = handler;
  return wrapped;
}
function onDocumentCreated(path, handler) {
  const wrapped = async (event) => handler(event);
  wrapped.__isTrigger = true;
  wrapped.__handler = handler;
  return wrapped;
}
module.exports = { onDocumentWritten, onDocumentCreated };
