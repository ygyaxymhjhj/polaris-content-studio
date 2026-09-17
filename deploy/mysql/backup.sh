#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_dir=/opt/polaris-mysql/backups
install -d -m 700 "$backup_dir"
file="$backup_dir/polaris-$(date +%Y%m%d-%H%M%S).sql.gz"
trap 'rm -f "$file.tmp"' EXIT
docker exec polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --no-tablespaces --databases polaris_content_studio' | gzip > "$file.tmp"
gzip -t "$file.tmp"
mv "$file.tmp" "$file"
find "$backup_dir" -maxdepth 1 -name 'polaris-*.sql.gz' -type f -mtime +13 -delete
printf 'Backup saved: %s\n' "$file"
