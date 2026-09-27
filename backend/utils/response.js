export function success(res, data = {}, message = 'Operation successful', status = 200) {
  return res.status(status).json({ success: true, message, data });
}

export function error(res, message = 'Something went wrong', status = 400, code = null) {
  const payload = { success: false, message };
  if (code) payload.code = code;
  return res.status(status).json(payload);
}