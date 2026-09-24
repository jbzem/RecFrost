"""RecFrost server ops panel.

A little tkinter GUI for the boring-but-critical stuff: pick a worker app,
pick a command (deploy / migrate / test / typecheck / build), watch the logs
scroll by. Also has a Status view (latest prod deployment per worker) and a
Deploy-ALL mode.

Run from anywhere:  python panel.py
Works from wherever this file lives — that directory is treated as the repo
root (it must contain deploy.bat, apps/, packages/ and .env).

Notes:
- CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are loaded from the root .env
  into this process (never printed) so deploys authenticate.
- Commands run in a background thread; the log streams live. Stop kills the
  running command (best effort on Windows).
"""

from __future__ import annotations

import json
import os
import queue
import re
import ssl
import subprocess
import sys
import threading
import tkinter as tk
import urllib.request
from datetime import date
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk

ROOT = Path(__file__).resolve().parent
ALL_APPS = 'ALL WORKERS'

# `runx admin` subcommands, mirroring CLI.md. `target` shows the username/account
# picker, `amount` a positional integer (reload-plus), `file` a --file path
# (cai-load, prefilled with the CLI default), `dryrun` the --dry-run flag.
ADMIN_COMMANDS: dict[str, dict] = {
    'lookup': {'desc': 'Print an account', 'target': True, 'pw': False,
               'revoke': False, 'amount': False, 'file': False, 'dryrun': False},
    'set-password': {'desc': "Set (or replace) the login password", 'target': True,
                     'pw': True, 'revoke': False, 'amount': False, 'file': False,
                     'dryrun': False},
    'clear-password': {'desc': 'Remove the password (platform login only)',
                       'target': True, 'pw': False, 'revoke': False, 'amount': False,
                       'file': False, 'dryrun': False},
    'grant-developer': {'desc': 'Grant/remove the developer role', 'target': True,
                        'pw': False, 'revoke': True, 'amount': False, 'file': False,
                        'dryrun': False},
    'grant-moderator': {'desc': 'Grant/remove the moderator role', 'target': True,
                        'pw': False, 'revoke': True, 'amount': False, 'file': False,
                        'dryrun': False},
    'grant-plus': {'desc': 'Grant/remove Rec Room Plus', 'target': True,
                   'pw': False, 'revoke': True, 'amount': False, 'file': False,
                   'dryrun': False},
    'reload-plus': {'desc': 'Credit every Plus subscriber <amount> tokens',
                    'target': False, 'pw': False, 'revoke': False, 'amount': True,
                    'file': False, 'dryrun': True},
    'cai-load': {'desc': 'Load first-party avatar items from export JSON',
                 'target': False, 'pw': False, 'revoke': False, 'amount': False,
                 'file': True, 'dryrun': True},
}

CAI_EXPORT_DEFAULT = 'apps/econ/static/db/2025-1-cai.json'


# --------------------------------------------------------------------------- env
def load_dotenv() -> dict[str, str]:
    """Read the root .env into a dict (values stay in-process, never logged)."""
    vals: dict[str, str] = {}
    env_file = ROOT / '.env'
    if not env_file.exists():
        return vals
    for line in env_file.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        vals[key] = value
    return vals


ENV = load_dotenv()
for secret in ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'):
    if ENV.get(secret) and not os.environ.get(secret):
        os.environ[secret] = ENV[secret]


def discover_apps() -> list[str]:
    apps_dir = ROOT / 'apps'
    if not apps_dir.is_dir():
        return []
    return sorted(
        p.name for p in apps_dir.iterdir() if p.is_dir() and (p / 'package.json').exists()
    )


def app_scripts(app: str) -> set[str]:
    try:
        pkg = json.loads((ROOT / 'apps' / app / 'package.json').read_text(encoding='utf-8'))
    except OSError:
        return set()
    return set(pkg.get('scripts', {}))


# --------------------------------------------------------------------------- gui
class Panel(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title('RecFrost server panel')
        self.geometry('980x660')
        self.apps = discover_apps()
        self.proc: subprocess.Popen | None = None
        self.stop_requested = False
        self.lines: queue.Queue[str | None] = queue.Queue()
        self._build()
        self._poll()

    # -- layout ------------------------------------------------------------
    def _build(self) -> None:
        top = ttk.Frame(self, padding=10)
        top.pack(fill='x')

        ttk.Label(top, text='App:').pack(side='left')
        self.app_var = tk.StringVar(value='api' if 'api' in self.apps else (self.apps[0] if self.apps else ''))
        self.app_combo = ttk.Combobox(top, textvariable=self.app_var, width=22,
                                      values=[ALL_APPS, *self.apps], state='readonly')
        self.app_combo.pack(side='left', padx=(4, 12))
        self.app_combo.bind('<<ComboboxSelected>>', lambda _e: self._refresh_buttons())

        self.btns: dict[str, ttk.Button] = {}
        for label, cmd in [('Deploy', 'deploy'), ('Migrate', 'migrate'), ('Test', 'test'),
                           ('Types', 'types'), ('Build', 'build'), ('Status', 'status')]:
            btn = ttk.Button(top, text=label, command=lambda c=cmd: self.run_command(c))
            btn.pack(side='left', padx=2)
            self.btns[cmd] = btn
        self.stop_btn = ttk.Button(top, text='Stop', command=self.stop, state='disabled')
        self.stop_btn.pack(side='left', padx=(10, 2))

        cred = 'token: ' + ('loaded' if os.environ.get('CLOUDFLARE_API_TOKEN') else 'MISSING')
        ttk.Label(top, text=cred, foreground='gray').pack(side='right')
        self.insecure_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(top, text='Bypass TLS verify (proxy/VPN)', variable=self.insecure_var,
                        command=self._apply_tls).pack(side='right', padx=(0, 8))
        self._refresh_buttons()

        admin = ttk.LabelFrame(self, text='Admin  (runx admin …)', padding=10)
        admin.pack(fill='x', padx=10)
        ttk.Label(admin, text='Command:').pack(side='left')
        self.admin_var = tk.StringVar(value='lookup')
        self.admin_combo = ttk.Combobox(
            admin, textvariable=self.admin_var, width=18,
            values=[f'{name} — {spec["desc"]}' for name, spec in ADMIN_COMMANDS.items()],
            state='readonly')
        self.admin_combo.pack(side='left', padx=(4, 10))
        self.admin_combo.bind('<<ComboboxSelected>>', lambda _e: self._refresh_admin())

        self.target_kind = tk.StringVar(value='username')
        self.target_radios = [
            ttk.Radiobutton(admin, text='Username', variable=self.target_kind,
                            value='username'),
            ttk.Radiobutton(admin, text='Account id', variable=self.target_kind,
                            value='account'),
        ]
        for radio in self.target_radios:
            radio.pack(side='left')
        self.target_entry = ttk.Entry(admin, width=22)
        self.target_entry.pack(side='left', padx=(4, 10))
        self.target_entry.insert(0, 'citizen')

        self.remote_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(admin, text='prod (--remote)', variable=self.remote_var).pack(side='left')

        self.pw_label = ttk.Label(admin, text='Password:')
        self.pw_entry = ttk.Entry(admin, width=18, show='•')
        self.revoke_var = tk.BooleanVar(value=False)
        self.revoke_check = ttk.Checkbutton(admin, text='--revoke', variable=self.revoke_var)
        self.amount_label = ttk.Label(admin, text='Amount:')
        self.amount_entry = ttk.Entry(admin, width=10)
        self.file_label = ttk.Label(admin, text='File:')
        self.file_entry = ttk.Entry(admin, width=34)
        self.file_entry.insert(0, CAI_EXPORT_DEFAULT)
        self.dryrun_var = tk.BooleanVar(value=False)
        self.dryrun_check = ttk.Checkbutton(admin, text='--dry-run', variable=self.dryrun_var)
        self.admin_exec = ttk.Button(admin, text='Execute', command=self.run_admin)
        self.admin_exec.pack(side='left', padx=(10, 0))
        self._refresh_admin()

        bar = ttk.Frame(self, padding=(10, 0))
        bar.pack(fill='x')
        self.autoscroll = tk.BooleanVar(value=True)
        ttk.Checkbutton(bar, text='Autoscroll', variable=self.autoscroll).pack(side='left')
        ttk.Button(bar, text='Clear', command=self.clear).pack(side='left', padx=6)
        ttk.Button(bar, text='Save log…', command=self.save).pack(side='left')

        self.log = scrolledtext.ScrolledText(self, wrap='word', state='disabled',
                                             font=('Consolas', 10))
        self.log.pack(fill='both', expand=True, padx=10, pady=10)
        self.log.tag_config('err', foreground='#ff6b5e')

    def _apply_tls(self) -> None:
        # Opt-in escape hatch for TLS-intercepting proxies/VPNs, which break
        # node/bun/python verification while system-store apps keep working.
        # Deliberately NOT persisted: insecure on purpose, re-tick every launch.
        # Children inherit these at spawn: node and bun honor
        # NODE_TLS_REJECT_UNAUTHORIZED, and deploy.ps1 reads RECFLARE_INSECURE_TLS
        # itself for the same purpose.
        if self.insecure_var.get():
            os.environ['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
            os.environ['RECFLARE_INSECURE_TLS'] = '1'
            self.emit('TLS verification BYPASSED for child commands (proxy/VPN mode)', err=True)
        else:
            os.environ.pop('NODE_TLS_REJECT_UNAUTHORIZED', None)
            os.environ.pop('RECFLARE_INSECURE_TLS', None)
            self.emit('TLS verification restored')

    def _urlopen(self, req: urllib.request.Request, timeout: int = 30):
        if self.insecure_var.get():
            ctx = ssl._create_unverified_context()
        else:
            ctx = ssl.create_default_context()
        return urllib.request.urlopen(req, timeout=timeout, context=ctx)

    def _refresh_buttons(self) -> None:
        app = self.app_var.get()
        if app == ALL_APPS:
            for cmd, btn in self.btns.items():
                btn.config(state='normal' if cmd in ('deploy', 'status') else 'disabled')
            return
        scripts = app_scripts(app)
        avail = {'deploy': True, 'migrate': 'migrate' in scripts, 'test': 'test' in scripts,
                 'types': 'check:types' in scripts, 'build': 'build' in scripts,
                 'status': True}
        for cmd, btn in self.btns.items():
            btn.config(state='normal' if avail[cmd] else 'disabled')

    def _admin_name(self) -> str:
        return self.admin_var.get().split(' — ')[0]

    def _refresh_admin(self) -> None:
        spec = ADMIN_COMMANDS[self._admin_name()]

        def show(widget, visible):
            if visible:
                widget.pack(side='left')
            else:
                widget.pack_forget()

        for radio in self.target_radios:
            show(radio, spec['target'])
        if spec['target']:
            self.target_entry.pack(side='left', padx=(4, 10))
        else:
            self.target_entry.pack_forget()
        show(self.pw_label, spec['pw'])
        if spec['pw']:
            self.pw_entry.pack(side='left', padx=(4, 10))
        else:
            self.pw_entry.pack_forget()
        show(self.revoke_check, spec['revoke'])
        show(self.amount_label, spec['amount'])
        if spec['amount']:
            self.amount_entry.pack(side='left', padx=(4, 10))
        else:
            self.amount_entry.pack_forget()
        show(self.file_label, spec['file'])
        if spec['file']:
            self.file_entry.pack(side='left', padx=(4, 10))
        else:
            self.file_entry.pack_forget()
        show(self.dryrun_check, spec['dryrun'])

    def run_admin(self) -> None:
        cmd = self._admin_name()
        spec = ADMIN_COMMANDS[cmd]
        target = self.target_entry.get().strip()
        if spec['target']:
            if not target:
                messagebox.showwarning('RecFrost panel', 'Enter a username or account id first.')
                return
            if self.target_kind.get() == 'account' and not target.isdigit():
                messagebox.showwarning('RecFrost panel', 'Account id must be numeric.')
                return
        password = self.pw_entry.get()
        if spec['pw'] and not password:
            # The CLI would prompt on a TTY; headless here that hangs, so require it.
            messagebox.showwarning('RecFrost panel', 'Enter the new password first.')
            return
        amount = self.amount_entry.get().strip()
        if spec['amount'] and (not amount.isdigit() or int(amount) < 1):
            messagebox.showwarning('RecFrost panel', 'Amount must be a positive integer.')
            return
        filename = self.file_entry.get().strip()
        if spec['file'] and not filename:
            messagebox.showwarning('RecFrost panel', 'Enter the export file path first.')
            return
        argv = ['bun',
                str(ROOT / 'packages' / 'tools' / 'src' / 'bin' / 'runx.cmd.ts'),
                'admin', cmd]
        if spec['amount']:
            argv.append(amount)
        if spec['target']:
            argv += [f'--{self.target_kind.get()}', target]
        if spec['pw']:
            argv += ['--password', password]
        if spec['revoke'] and self.revoke_var.get():
            argv.append('--revoke')
        if spec['file']:
            argv += ['--file', filename]
        if spec['dryrun'] and self.dryrun_var.get():
            argv.append('--dry-run')
        if self.remote_var.get():
            argv.append('--remote')
        if self.remote_var.get() and cmd != 'lookup':
            if not messagebox.askyesno(
                    'RecFrost panel',
                    f'{cmd} ({target or amount or filename}) (PROD). Proceed?'):
                return
        self.pw_entry.delete(0, 'end')
        self.stop_requested = False
        self._set_running(True)
        threading.Thread(target=self._admin_worker, args=(argv,), daemon=True).start()

    def _admin_worker(self, argv: list[str]) -> None:
        try:
            shown = [a if not a.startswith('cfat') and len(a) < 60 else '<hidden>'
                     for a in argv if a != '--password']
            if '--password' in argv:
                shown.append('--password <hidden>')
            self.emit('$ ' + ' '.join(shown) + '  (cwd=repo root)')
            code = self.spawn(argv, cwd=ROOT)
            self.emit(f'exit code: {code}')
        except Exception as exc:
            self.emit(f'panel error: {exc}', err=True)
        finally:
            self.lines.put(None)

    # -- log ---------------------------------------------------------------
    def emit(self, text: str, err: bool = False) -> None:
        self.lines.put(('ERR:' if err else '') + text)

    def _poll(self) -> None:
        try:
            while True:
                item = self.lines.get_nowait()
                if item is None:
                    self._set_running(False)
                    continue
                self.log.config(state='normal')
                tag = 'err' if item.startswith('ERR:') else None
                self.log.insert('end', (item[4:] if tag else item) + '\n', tag)
                self.log.config(state='disabled')
                if self.autoscroll.get():
                    self.log.see('end')
        except queue.Empty:
            pass
        self.after(100, self._poll)

    def clear(self) -> None:
        self.log.config(state='normal')
        self.log.delete('1.0', 'end')
        self.log.config(state='disabled')

    def save(self) -> None:
        path = filedialog.asksaveasfilename(defaultextension='.log',
                                            filetypes=[('Log files', '*.log')])
        if path:
            Path(path).write_text(self.log.get('1.0', 'end'), encoding='utf-8')

    # -- running -----------------------------------------------------------
    def _set_running(self, running: bool) -> None:
        for btn in self.btns.values():
            btn.config(state='disabled' if running else 'normal')
        self.stop_btn.config(state='normal' if running else 'disabled')
        self.admin_exec.config(state='disabled' if running else 'normal')
        if not running:
            self._refresh_buttons()
            self.proc = None

    def run_command(self, cmd: str) -> None:
        app = self.app_var.get()
        self.stop_requested = False
        self._set_running(True)
        threading.Thread(target=self._worker, args=(cmd, app), daemon=True).start()

    def stop(self) -> None:
        self.stop_requested = True
        if self.proc and self.proc.poll() is None:
            self.emit('--- stop requested, terminating ---', err=True)
            try:
                self.proc.terminate()
            except OSError:
                pass

    def _deploy_argv(self, app: str) -> list[str]:
        # Call deploy.ps1 directly instead of deploy.bat: cmd.exe mangles quoted
        # paths containing spaces/parens (e.g. "RecFrost Private Development"),
        # while an argv list reaches powershell.exe untouched via CreateProcess.
        return ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                str(ROOT / 'deploy.ps1'), '-App', app, '-Root', str(ROOT)]

    def _worker(self, cmd: str, app: str) -> None:
        try:
            if cmd == 'status':
                self.show_status()
            elif cmd == 'deploy' and app == ALL_APPS:
                targets = [a for a in self.apps if (ROOT / 'apps' / a / 'wrangler.jsonc').exists()]
                self.emit(f'=== deploying {len(targets)} workers ===')
                failed = []
                for target in targets:
                    if self.stop_requested:
                        self.emit('--- stopped by user ---', err=True)
                        break
                    self.emit(f'===== {target} =====')
                    code = self.spawn(self._deploy_argv(target), cwd=ROOT)
                    if code != 0:
                        failed.append(target)
                        self.emit(f'{target} FAILED (exit {code})', err=True)
                self.emit('ALL DONE. failed: ' + (', '.join(failed) if failed else 'none'))
            elif cmd == 'deploy':
                code = self.spawn(self._deploy_argv(app), cwd=ROOT)
                self.emit(f'exit code: {code}')
            else:
                script = {'migrate': 'migrate', 'test': 'test', 'types': 'check:types',
                          'build': 'build'}[cmd]
                code = self.spawn(['bun', 'run', script], cwd=ROOT / 'apps' / app)
                self.emit(f'exit code: {code}')
        except Exception as exc:  # keep the GUI alive no matter what
            self.emit(f'panel error: {exc}', err=True)
        finally:
            self.lines.put(None)

    def spawn(self, argv: list[str], cwd: Path, shell: bool = False) -> int:
        """Run a command, streaming merged output into the log. Returns exit code."""
        self.emit(f'$ {" ".join(argv)}  (cwd={cwd})')
        self.proc = subprocess.Popen(
            argv, cwd=str(cwd), shell=shell, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, errors='replace',
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
        )
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.emit(line.rstrip('\n'))
            if self.stop_requested:
                break
        return self.proc.wait()

    # -- status ------------------------------------------------------------
    def show_status(self) -> None:
        token = os.environ.get('CLOUDFLARE_API_TOKEN', '')
        m = re.search(r'CLOUDFLARE_ACCOUNT_ID\s*=\s*(\S+)',
                      (ROOT / '.env').read_text(encoding='utf-8')) if (ROOT / '.env').exists() else None
        acct = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '') or (m.group(1) if m else '')
        if not token or not acct:
            self.emit('missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID', err=True)
            return
        today = date.today().isoformat()
        for app in self.apps:
            if self.stop_requested:
                break
            url = (f'https://api.cloudflare.com/client/v4/accounts/{acct}'
                   f'/workers/scripts/{app}/deployments')
            try:
                req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
                data = json.load(self._urlopen(req))
                latest = data['result']['deployments'][0]['created_on']
                mark = 'TODAY' if latest.startswith(today) else 'stale'
                self.emit(f'{app:22s} {latest}  [{mark}]')
            except Exception as exc:
                self.emit(f'{app:22s} ERROR {exc}', err=True)


if __name__ == '__main__':
    if not (ROOT / 'deploy.ps1').exists() and not (ROOT / 'apps').is_dir():
        messagebox.showwarning(
            'RecFrost panel',
            f'{ROOT} does not look like the server root.\n'
            'Move panel.py next to deploy.ps1 and apps/, then reopen it.')
    Panel().mainloop()
