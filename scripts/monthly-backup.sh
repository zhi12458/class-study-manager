#!/bin/sh
set -eu

database_path="${DB_PATH:-/data/class-study.sqlite}"
backup_dir="${BACKUP_DIR:-/backups}"
retention_days="${BACKUP_RETENTION_DAYS:-400}"

case "$retention_days" in
  ''|*[!0-9]*)
    echo "BACKUP_RETENTION_DAYS 必须是非负整数" >&2
    exit 2
    ;;
esac

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "未找到 sqlite3，无法创建一致性备份" >&2
  exit 1
fi

if [ ! -f "$database_path" ]; then
  echo "数据库不存在：$database_path" >&2
  exit 1
fi

umask 077
mkdir -p "$backup_dir"

timestamp="$(date '+%Y%m%d-%H%M%S')"
backup_name="class-study-${timestamp}.sqlite"
final_path="${backup_dir}/${backup_name}"
temporary_path="${backup_dir}/.${backup_name}.$$.partial"

cleanup() {
  if [ -n "${temporary_path:-}" ] && [ -f "$temporary_path" ]; then
    rm -f "$temporary_path"
  fi
}

on_signal() {
  cleanup
  exit 1
}

trap cleanup EXIT
trap on_signal HUP INT TERM

# SQLite 的在线备份命令会把 WAL 中已提交的数据一并复制到独立数据库。
sqlite3 "$database_path" ".timeout 10000" ".backup '$temporary_path'"

check_result="$(sqlite3 "$temporary_path" 'PRAGMA quick_check;')"
if [ "$check_result" != "ok" ]; then
  echo "备份完整性检查失败：$check_result" >&2
  exit 1
fi

mv "$temporary_path" "$final_path"
temporary_path=""

(
  cd "$backup_dir"
  sha256sum "$backup_name" > "${backup_name}.sha256"
)

find "$backup_dir" -type f \( \
  -name 'class-study-*.sqlite' -o \
  -name 'class-study-*.sqlite.sha256' \
\) -mtime "+$retention_days" -exec rm -f {} \;

echo "备份完成：$final_path"
