import type { NextFunction, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { AuthUser, ClassPermission } from "../shared/types.js";

export interface AuthedRequest extends Request {
  user?: AuthUser;
  classPermission?: ClassPermission;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "请先登录" });
    return;
  }
  if (req.user.mustChangePassword && req.path !== "/auth/change-password" && req.path !== "/auth/logout" && req.path !== "/auth/me") {
    res.status(403).json({ error: "请先修改临时密码", code: "PASSWORD_CHANGE_REQUIRED" });
    return;
  }
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) return void res.status(401).json({ error: "请先登录" });
  if (!req.user.isAdmin) return void res.status(403).json({ error: "需要管理员权限" });
  next();
}

export function requireClassAccess(db: DatabaseSync, manage = false) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) return void res.status(401).json({ error: "请先登录" });
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId) || classId < 1) return void res.status(400).json({ error: "班级 ID 无效" });
    const classRow = db.prepare("select archived, counselor_user_id as counselorUserId from classes where id = ?").get(classId) as
      | { archived: number; counselorUserId: number }
      | undefined;
    if (!classRow) return void res.status(404).json({ error: "班级不存在" });
    if (req.user.isAdmin || classRow.counselorUserId === req.user.id) {
      req.classPermission = "counselor";
      next();
      return;
    }
    const monitor = db.prepare("select 1 from class_monitors where class_id = ? and user_id = ?").get(classId, req.user.id);
    if (!monitor || manage || classRow.archived) return void res.status(403).json({ error: "无权访问该班级" });
    req.classPermission = "monitor";
    next();
  };
}
