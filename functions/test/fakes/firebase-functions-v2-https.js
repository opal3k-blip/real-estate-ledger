class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function onCall(handler) {
  // في الاختبار، نُعيد الدالة نفسها لنستدعيها مباشرة بـ({data, auth}) بلا محاكي Functions كامل.
  const wrapped = async (request) => handler(request);
  wrapped.__isOnCall = true;
  wrapped.__handler = handler;
  return wrapped;
}
function onRequest(optsOrHandler, maybeHandler) {
  const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
  const wrapped = async (req, res) => handler(req, res);
  wrapped.__isRequest = true;
  return wrapped;
}
module.exports = { HttpsError, onCall, onRequest };
