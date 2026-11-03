# Vault service start (vault/broker.py runs this as openclaw-vault): sign in,
# unlock and sync. rbw keeps working from its local copy of the vault when a
# sync fails, so a refused sign-in went unnoticed (vault edits silently
# stopped arriving). Here a failed sync is logged, and when Vaultwarden
# itself is up (GET $VW_URL/alive answers) the stored sign-in is dropped
# (rbw purge) and made again from the saved master password. If that fails
# too, the previous local copy is put back, so lookups keep working.
set -u
rbw=/usr/libexec/openclaw-vault/rbw
cache="$XDG_CACHE_HOME/rbw"
backup="$XDG_CACHE_HOME/rbw.before-relogin"
$rbw stop-agent >/dev/null 2>&1 || true
sleep 1
timeout 90 $rbw login || echo "rbw login: exit $?" >&2
timeout 90 $rbw unlock || echo "rbw unlock: exit $?" >&2
if err=$(timeout 120 $rbw sync 2>&1 >/dev/null); then
  echo "Vault synced"
else
  echo "rbw sync failed: $(printf '%s' "${err:-timed out}" | head -n 1)" >&2
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$VW_URL/alive" 2>/dev/null || true)
  case $code in
    2??)
      echo "Vaultwarden is up but the sync failed: signing in to Vaultwarden again" >&2
      rm -rf "$backup"
      cp -a "$cache" "$backup" 2>/dev/null || true
      $rbw purge >/dev/null 2>&1 || true
      if timeout 90 $rbw login && timeout 90 $rbw unlock && err=$(timeout 120 $rbw sync 2>&1 >/dev/null); then
        echo "Signed in to Vaultwarden again; vault synced"
        rm -rf "$backup"
      else
        echo "Signing in again did not help ($(printf '%s' "${err:-see above}" | head -n 1)); keeping the previous local copy of the vault" >&2
        $rbw stop-agent >/dev/null 2>&1 || true
        if [ -d "$backup" ]; then rm -rf "$cache"; mv "$backup" "$cache"; fi
        timeout 90 $rbw unlock || true
      fi
      ;;
    *)
      echo "Vaultwarden did not answer at $VW_URL/alive (HTTP ${code:-none}): using the local copy of the vault; vault changes arrive once a sync works again" >&2
      ;;
  esac
fi
$rbw unlocked
