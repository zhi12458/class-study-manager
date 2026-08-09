export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string, code?: string): HttpError {
  return new HttpError(400, message, code);
}

export interface PublicError {
  status: number;
  message: string;
  code?: string;
  internal: boolean;
}

export function classifyHttpError(error: unknown): PublicError {
  if (error instanceof HttpError) {
    return { status: error.status, message: error.message, code: error.code, internal: error.status >= 500 };
  }
  const record = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const code = String(record.code ?? "");
  const message = error instanceof Error ? error.message : "";

  if (code.startsWith("LIMIT_")) {
    return { status: 400, message: "上传文件无效或超过大小限制", code: "UPLOAD_INVALID", internal: false };
  }
  if (code.startsWith("SQLITE_CONSTRAINT")) {
    return { status: 409, message: "数据与现有记录冲突，请检查后重试", code: "DATA_CONFLICT", internal: false };
  }
  if (code.startsWith("SQLITE_")) {
    return { status: 500, message: "服务器暂时无法处理请求", code: "INTERNAL_ERROR", internal: true };
  }
  if (error instanceof SyntaxError && "body" in record) {
    return { status: 400, message: "请求内容格式无效", code: "INVALID_JSON", internal: false };
  }
  if (/官方课程目录读取失败|课程目录为空|课程目录结构不完整/.test(message)) {
    return { status: 502, message: "课程目录暂时无法更新，请稍后重试", code: "COURSE_CATALOG_UNAVAILABLE", internal: true };
  }
  if (/[\u3400-\u9fff]/u.test(message)) {
    const conflict = /已存在|已被|重复|冲突|只能停用|不能永久删除/.test(message);
    return { status: conflict ? 409 : 400, message, code: conflict ? "CONFLICT" : "BAD_REQUEST", internal: false };
  }
  return { status: 500, message: "服务器暂时无法处理请求", code: "INTERNAL_ERROR", internal: true };
}
