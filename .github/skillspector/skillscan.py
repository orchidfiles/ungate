"""Static-only SkillSpector gate. Runs inside the unprivileged offline container."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


class SkillScan:
    ROOT = Path('/scan')
    EXCLUDED = {'.git', 'node_modules', '.direnv', 'target', '.build', '.cache'}
    NAMES = {'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules'}

    def __init__(self):
        self.files = sorted(set(os.fsdecode(item) for item in Path('/files').read_bytes().split(b'\0') if item))

    def allowed(self, name):
        path = Path(name)
        return not path.is_absolute() and '..' not in path.parts and not self.EXCLUDED.intersection(path.parts)

    def safe(self, name):
        path = self.ROOT
        for part in Path(name).parts:
            path = path / part
            if path.is_symlink():
                raise RuntimeError(f'Symlink requires explicit review: {name!r}')
            if path != self.ROOT and path.is_dir() and (path / '.git').exists():
                raise RuntimeError(f'Nested repository requires a separate scan: {name!r}')
        if not path.is_file():
            raise RuntimeError(f'Selected file is missing or not regular: {name!r}')
        return path

    def targets(self):
        selected = set()
        for name in self.files:
            if not self.allowed(name):
                continue
            path = Path(name)
            if path.name == 'SKILL.md':
                selected.add((str(path.parent), True))
            elif path.name in self.NAMES or ('.cursor/rules/' in '/' + name and path.suffix == '.mdc'):
                selected.add((name, False))
        return sorted(selected)

    def run(self):
        targets = self.targets()
        if not targets:
            Path('/reports/summary.json').write_text(json.dumps({'status': 'NO_TARGETS', 'targets': 0}))
            return 3
        result = 0
        summary = []
        for index, (name, directory) in enumerate(targets):
            with tempfile.TemporaryDirectory(prefix='skillscan-') as temp:
                snapshot = Path(temp) / 'input'
                if directory:
                    snapshot.mkdir()
                    prefix = '' if name == '.' else name + '/'
                    for file in self.files:
                        if self.allowed(file) and file.startswith(prefix):
                            source = self.safe(file)
                            destination = snapshot / file[len(prefix):]
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(source, destination)
                else:
                    snapshot = Path(temp) / Path(name).name
                    shutil.copyfile(self.safe(name), snapshot)
                report = Path('/reports') / f'{index}.json'
                log = Path('/reports') / f'{index}.log'
                with report.open('wb') as out, log.open('wb') as err:
                    try:
                        completed = subprocess.run(
                            ['skillspector', 'scan', str(snapshot), '--no-llm', '--format', 'json',
                             '--fail-on-findings', '--fail-on-incomplete'],
                            stdout=out, stderr=err, timeout=180, check=False)
                        code = completed.returncode
                    except subprocess.TimeoutExpired:
                        code = 2
                if code not in (0, 1):
                    code = 2
                try:
                    parsed = json.loads(report.read_text())
                    if not isinstance(parsed, dict) or not parsed:
                        code = 2
                except (ValueError, UnicodeError):
                    code = 2
                result = max(result, code)
                status = {0: 'PASS_STATIC', 1: 'FINDINGS_OR_INCOMPLETE', 2: 'SCAN_ERROR'}[code]
                summary.append({'target': name, 'status': status, 'exit': code})
                print(f'{status} {name!r}', flush=True)
        Path('/reports/summary.json').write_text(json.dumps(summary, indent=2))
        return result


if __name__ == '__main__':
    try:
        sys.exit(SkillScan().run())
    except Exception as error:
        print(f'SCAN_ERROR: {error}', file=sys.stderr)
        sys.exit(2)
