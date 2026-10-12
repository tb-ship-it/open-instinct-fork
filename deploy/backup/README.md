# Backups

`bobby-backup.sh` makes an encrypted archive of everything that is not in git:

- the data directory (`.instinct`: memory, conversations, connector keys, the WhatsApp login),
- the env file with the API keys (`~/.instinct.env`),
- the deploy hook, systemd unit, crontab and the deployed commit, under `extra/`.

The archive is checked (decrypted and listed) before it is kept. The last 3 stay in
`~/backups/bobby`, and each one is uploaded to Google Drive (`Bobby backups` in the My Drive of
the account rclone was authorised with), where 14 days are kept.

The archive is `tar | zstd | gpg --symmetric` (AES-256). **The passphrase is the only way to
read it**: keep a copy off the Pi (a password manager), or a dead SD card takes the backups with it.

## Setup (once)

```sh
mkdir -p ~/.config/bobby-backup && chmod 700 ~/.config/bobby-backup
openssl rand -base64 32 > ~/.config/bobby-backup/passphrase && chmod 600 ~/.config/bobby-backup/passphrase
# rclone in ~/.local/bin: https://downloads.rclone.org/rclone-current-linux-arm64.zip
# On a machine with a browser: rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ"
# (drive.file: rclone only sees what it created), then put the token in a "gdrive" remote:
#   [gdrive]
#   type = drive
#   scope = drive.file
#   token = {...}
# in ~/.config/rclone/rclone.conf (mode 600).
crontab -e   # 30 3 * * * $HOME/open-instinct/deploy/backup/bobby-backup.sh >> $HOME/backups/bobby/backup.log 2>&1
```

`~/.config/bobby-backup/last-ok` holds the time of the last full success; the log is
`~/backups/bobby/backup.log`.

## Restore

```sh
rclone copy "gdrive:Bobby backups/<file>" .        # or take one from ~/backups/bobby
gpg -d <file> | zstd -d | tar -xf - -C /tmp/restore  # asks for the passphrase
sudo systemctl stop instinct
mv ~/open-instinct/.instinct ~/open-instinct/.instinct.old
cp -a /tmp/restore/.instinct ~/open-instinct/
install -m 600 /tmp/restore/extra/instinct.env ~/.instinct.env
sudo systemctl start instinct
```

On a fresh machine, clone the repo first, check out `extra/commit`, build, and use
`extra/instinct.service`, `extra/post-receive` and `extra/crontab` to put the rest back.
