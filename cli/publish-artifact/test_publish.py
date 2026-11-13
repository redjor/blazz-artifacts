import io
import os
import re
import sys
import tempfile
import unittest
import urllib.parse
import zipfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish  # noqa: E402

TOKEN = 'SECRET-TOKEN-VALUE-1234567890abcdefghijklmn'
SESSION = f'publish-thumb-{os.getpid()}'


class SlugifyTest(unittest.TestCase):
    def test_cases(self):
        cases = {
            'Mon Rapport.md': 'mon-rapport',
            'Café Crème.html': 'cafe-creme',
            'maquettes': 'maquettes',
            'v1.2 notes': 'v1-2-notes',
            'archive.zip': 'archive',
            '--Hello__World--.pdf': 'hello-world',
            'admin.html': 'artifact',
            'share': 'artifact',
            '': 'artifact',
            '日本語.md': 'artifact',
            ('a' * 60 + '.md'): 'a' * 48,
            ('a' * 47 + ' b.md'): 'a' * 47,
        }
        for src, want in cases.items():
            self.assertEqual(publish.slugify(src), want, src)


class ZipTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'site'
        self.root.mkdir()
        self.addCleanup(self.tmp.cleanup)

    def write(self, rel, data='x'):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(data)

    def test_exclusions_and_relative_paths(self):
        for rel in ['index.html', 'css/a.css', 'sub/page.html', '.DS_Store', 'sub/.DS_Store', '__MACOSX/x', '.git/config',
                    'node_modules/m/index.js', 'sub/node_modules/y.js', 'inner.zip']:
            self.write(rel)
        dest = Path(self.tmp.name) / 'out.zip'
        count, size, skipped = publish.build_zip(self.root, dest)
        with zipfile.ZipFile(dest) as zf:
            names = sorted(zf.namelist())
        self.assertEqual(names, ['css/a.css', 'index.html', 'inner.zip', 'sub/page.html'])
        self.assertEqual(count, 4)
        self.assertEqual(skipped, 0)
        self.assertEqual(size, dest.stat().st_size)

    def test_dotfiles_skipped_by_default_and_counted(self):
        for rel in ['index.html', '.env', '.vscode/settings.json', '.vscode/x.json', 'ok.css', '.git/config', '.DS_Store']:
            self.write(rel)
        (self.root / 'link.html').symlink_to(self.root / 'index.html')
        dest = Path(self.tmp.name) / 'o.zip'
        count, _, skipped = publish.build_zip(self.root, dest)
        with zipfile.ZipFile(dest) as zf:
            self.assertEqual(sorted(zf.namelist()), ['index.html', 'ok.css'])
        self.assertEqual((count, skipped), (2, 4))  # .env, 2 dans .vscode, 1 lien (.git/.DS_Store jamais comptés)
        count, _, skipped = publish.build_zip(self.root, dest, include_dotfiles=True)
        with zipfile.ZipFile(dest) as zf:
            self.assertEqual(sorted(zf.namelist()), ['.env', '.vscode/settings.json', '.vscode/x.json', 'index.html', 'ok.css'])
        self.assertEqual(skipped, 1)

    def test_old_timestamps_accepted(self):
        self.write('index.html')
        os.utime(self.root / 'index.html', (0, 0))
        publish.build_zip(self.root, Path(self.tmp.name) / 'o.zip')

    def test_index_required_at_root(self):
        self.write('sub/index.html')
        with self.assertRaises(publish.PublishError):
            publish.build_zip(self.root, Path(self.tmp.name) / 'o.zip')

    def test_temp_zip_removed_on_error(self):
        self.write('sub/index.html')
        made = []
        real = tempfile.mkstemp

        def spy(*a, **k):
            fd, name = real(*a, **k)
            made.append(name)
            return fd, name

        with mock.patch('tempfile.mkstemp', spy), self.assertRaises(publish.PublishError):
            publish.run(publish.parse_args([str(self.root)]))
        self.assertEqual(len(made), 1)
        self.assertFalse(os.path.exists(made[0]))

    def test_name_from_given_path_not_resolved(self):
        self.write('index.html')
        link = Path(self.tmp.name) / 'Mon Lien'
        link.symlink_to(self.root)
        out = io.StringIO()
        with redirect_stdout(out):
            publish.run(publish.parse_args([str(link), '--dry-run']))
        self.assertIn('"slug": "mon-lien"', out.getvalue())

    def test_temp_zip_removed(self):
        self.write('index.html')
        created = []
        args = publish.parse_args([str(self.root), '--dry-run'])
        with redirect_stdout(io.StringIO()), mock.patch('tempfile.mkstemp', wraps=tempfile.mkstemp) as mk:
            publish.run(args)
            created = [call for call in mk.call_args_list]
        self.assertEqual(len(created), 1)
        leftovers = [f for f in os.listdir(tempfile.gettempdir()) if f.startswith('artifact-hub-') and f.endswith('.zip')]
        self.assertEqual(leftovers, [])


class SecretTest(unittest.TestCase):
    def test_dry_run_output_has_no_token(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'page.html'
            f.write_text('<p>x</p>')
            out = io.StringIO()
            with mock.patch.dict(os.environ, {'ARTIFACT_HUB_TOKEN': TOKEN, 'ARTIFACT_HUB_URL': 'https://hub.example'}), redirect_stdout(out):
                code = publish.main([str(f), '--visibility', 'code', '--code', 'abcdef', '--dry-run'])
        self.assertEqual(code, 0)
        self.assertNotIn(TOKEN, out.getvalue())
        self.assertNotIn('abcdef', out.getvalue())
        self.assertIn('/api/artifacts?slug=page', out.getvalue())

    def test_curl_config_keeps_token_out_of_argv(self):
        cfg = publish.curl_config(TOKEN, 'POST', 'https://hub.example/api/artifacts', fields={'title': 'T "q"'}, file=(Path('/tmp/a;b.html'), 'a.html'))
        self.assertIn(f'Authorization: Bearer {TOKEN}', cfg)
        self.assertIn('form-string = "title=T \\"q\\""', cfg)
        captured = {}

        def fake_run(argv, **kw):
            captured['argv'] = argv
            captured['input'] = kw.get('input')
            return mock.Mock(returncode=0, stdout='{"ok":1}\n200', stderr='')

        with mock.patch('subprocess.run', fake_run):
            publish.call(TOKEN, 'GET', 'https://hub.example/api/artifacts')
        self.assertEqual(captured['argv'], ['curl', '--config', '-'])
        self.assertNotIn(TOKEN, ' '.join(captured['argv']))
        self.assertIn(TOKEN, captured['input'])

    def test_server_error_message_without_token(self):
        def fake_run(argv, **kw):
            return mock.Mock(returncode=0, stdout='{"error":"Invalid API token"}\n401', stderr='')

        with mock.patch('subprocess.run', fake_run):
            with self.assertRaises(publish.PublishError) as cm:
                publish.call(TOKEN, 'GET', 'https://hub.example/api/artifacts')
        self.assertIn('Invalid API token', str(cm.exception))
        self.assertNotIn(TOKEN, str(cm.exception))


class EnvTest(unittest.TestCase):
    def test_artifact_hub_variables_win_over_blazz_aliases(self):
        env = {'ARTIFACT_HUB_URL': 'https://a.example/', 'BLAZZ_ARTIFACTS_URL': 'https://b.example',
               'ARTIFACT_HUB_TOKEN': 'tok-a', 'BLAZZ_ARTIFACTS_TOKEN': 'tok-b'}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(publish.hub_url(), 'https://a.example')
            self.assertEqual(publish.api_token(), 'tok-a')

    def test_blazz_aliases_are_accepted(self):
        env = {'BLAZZ_ARTIFACTS_URL': 'https://b.example/', 'BLAZZ_ARTIFACTS_TOKEN': 'tok-b'}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(publish.hub_url(), 'https://b.example')
            self.assertEqual(publish.api_token(), 'tok-b')

    def test_missing_url_names_both_variables(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(publish.Path, 'home', return_value=Path(home)):
            with self.assertRaises(publish.PublishError) as cm:
                publish.hub_url()
        self.assertIn('ARTIFACT_HUB_URL', str(cm.exception))
        self.assertIn('BLAZZ_ARTIFACTS_URL', str(cm.exception))


class SlugSafetyTest(unittest.TestCase):
    def test_invalid_slugs_exit_2_before_network(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'a.md'
            f.write_text('x')
            for bad in ['rapport#v2', 'a&b', 'A', 'a--b', '-a', 'x' * 49, 'admin', 'a/b']:
                with mock.patch('subprocess.run') as run_, mock.patch('sys.stderr', io.StringIO()):
                    code = publish.main([str(f), f'--slug={bad}'])
                run_.assert_not_called()
                self.assertEqual(code, 2, bad)

    def test_query_is_url_encoded_and_exact_match_required(self):
        calls = []

        def fake_run(argv, **kw):
            calls.append(kw['input'])
            if len(calls) == 1:  # GET : le serveur renvoie un autre artifact
                return mock.Mock(returncode=0, stdout='[{"id":"X","slug":"rapport","visibility":"private","hasCode":false}]\n200', stderr='')
            return mock.Mock(returncode=0, stdout='{"id":"N","slug":"rapport-v2","title":"t","visibility":"private","url":"u"}\n201', stderr='')

        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {'ARTIFACT_HUB_TOKEN': TOKEN, 'ARTIFACT_HUB_URL': 'https://h.example'}), \
                mock.patch('subprocess.run', fake_run), redirect_stdout(io.StringIO()):
            f = Path(d) / 'rapport-v2.md'
            f.write_text('x')
            self.assertEqual(publish.main([str(f)]), 0)
        self.assertIn('?slug=rapport-v2', calls[0])
        self.assertIn('request = "POST"', calls[1])  # pas de PUT sur « rapport »

    def test_quote_in_query(self):
        self.assertEqual(urllib.parse.quote('a#b&c', safe=''), 'a%23b%26c')


class ValidationTest(unittest.TestCase):
    def run_main(self, argv, listing):
        calls = []

        def fake_run(a, **kw):
            calls.append(kw['input'])
            if len(calls) == 1:
                return mock.Mock(returncode=0, stdout=listing + '\n200', stderr='')
            return mock.Mock(returncode=0, stdout='{"id":"1","slug":"a","title":"t","visibility":"link","url":"u"}\n200', stderr='')

        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {'ARTIFACT_HUB_TOKEN': TOKEN, 'ARTIFACT_HUB_URL': 'https://h.example'}), \
                mock.patch('subprocess.run', fake_run), redirect_stdout(io.StringIO()), mock.patch('sys.stderr', io.StringIO()) as err:
            f = Path(d) / 'a.md'
            f.write_text('x')
            code = publish.main([str(f), *argv])
        return code, calls, err.getvalue()

    EXISTING = '[{"id":"1","slug":"a","visibility":"private","hasCode":false}]'

    def test_code_with_non_code_visibility_rejected_before_put(self):
        code, calls, _ = self.run_main(['--code', 'abcdef'], self.EXISTING)
        self.assertEqual(code, 2)
        self.assertEqual(len(calls), 1)

    def test_visibility_code_without_code_rejected_when_no_code_set(self):
        code, calls, _ = self.run_main(['--visibility', 'code'], self.EXISTING)
        self.assertEqual((code, len(calls)), (2, 1))
        code, calls, _ = self.run_main(['--visibility', 'code'], self.EXISTING.replace('"hasCode":false', '"hasCode":true'))
        self.assertEqual(code, 0)

    def test_link_hours_ignored_warns(self):
        _, _, err = self.run_main(['--link-hours', '2'], self.EXISTING)
        self.assertIn('--link-hours ignored', err)

    def test_link_failure_still_prints_summary_and_exits_1(self):
        calls = []

        def fake_run(a, **kw):
            calls.append(kw['input'])
            if len(calls) == 1:
                return mock.Mock(returncode=0, stdout='[]\n200', stderr='')
            if len(calls) == 2:
                return mock.Mock(returncode=0, stdout='{"id":"1","slug":"a","title":"t","visibility":"link","url":"u"}\n201', stderr='')
            return mock.Mock(returncode=0, stdout='{"error":"boom"}\n500', stderr='')

        out = io.StringIO()
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {'ARTIFACT_HUB_TOKEN': TOKEN, 'ARTIFACT_HUB_URL': 'https://h.example'}), \
                mock.patch('subprocess.run', fake_run), redirect_stdout(out), mock.patch('sys.stderr', io.StringIO()):
            f = Path(d) / 'a.md'
            f.write_text('x')
            code = publish.main([str(f), '--visibility', 'link', '--link-hours', '1'])
        self.assertEqual(code, 1)
        self.assertIn('created: t', out.getvalue())
        self.assertIn('url: u', out.getvalue())

    def test_real_run_prints_size_before_upload(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / 'index.html').write_text('x')
            order = []

            def fake_run(a, **kw):
                order.append('call')
                return mock.Mock(returncode=0, stdout='[]\n200' if len(order) == 1 else '{"id":"1","slug":"s","title":"t","visibility":"private","url":"u"}\n201', stderr='')

            out = io.StringIO()
            with mock.patch.dict(os.environ, {'ARTIFACT_HUB_TOKEN': TOKEN, 'ARTIFACT_HUB_URL': 'https://h.example'}), \
                    mock.patch('subprocess.run', fake_run), redirect_stdout(out):
                publish.main([d])
            self.assertIn('zipped folder: 1 file(s)', out.getvalue())


class ArgsTest(unittest.TestCase):
    def test_memory_storage_tristate(self):
        self.assertIsNone(publish.parse_args(['x']).memory_storage)
        self.assertTrue(publish.parse_args(['x', '--memory-storage']).memory_storage)
        self.assertFalse(publish.parse_args(['x', '--no-memory-storage']).memory_storage)

    def test_short_code_rejected(self):
        with self.assertRaises(SystemExit), mock.patch('sys.stderr', io.StringIO()):
            publish.parse_args(['x', '--code', 'abc'])


class LabelsTest(unittest.TestCase):
    def test_normalize_label(self):
        cases = {
            'Client Acme': 'client-acme', '  Café_Crème  ': 'cafe-creme', 'a  --  b': 'a-b', '-x-': 'x',
            'R&D!': 'rd', '': None, '   ': None, '日本語': None, '---': None,
            'a' * 31 + ' b': 'a' * 31, 'b' * 40: 'b' * 32,
        }
        for src, want in cases.items():
            self.assertEqual(publish.normalize_label(src), want, src)

    def test_parse_project_and_tags(self):
        self.assertIsNone(publish.parse_project(''))
        self.assertEqual(publish.parse_project(' Mon Client '), 'mon-client')
        with self.assertRaises(publish.UsageError):
            publish.parse_project('???')
        self.assertEqual(publish.parse_tags(['B', 'a', 'b ']), ['a', 'b'])
        with self.assertRaises(publish.UsageError):
            publish.parse_tags(['ok', '!!!'])
        with self.assertRaises(publish.UsageError):
            publish.parse_tags([f't{i}' for i in range(21)])


class ProjectTagsFlowTest(unittest.TestCase):
    ENV = {'ARTIFACT_HUB_TOKEN': TOKEN, 'ARTIFACT_HUB_URL': 'https://h.example'}
    ART = '{"id":"1","slug":"%s","title":"t","visibility":"private","url":"u","project":"acme","tags":["x"]}'

    def run_main(self, argv, responses, with_file=True):
        calls = []

        def fake_run(a, **kw):
            calls.append(kw['input'])
            return mock.Mock(returncode=0, stdout=responses[len(calls) - 1] + '\n200', stderr='')

        out, err = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', fake_run), \
                redirect_stdout(out), mock.patch('sys.stderr', err):
            f = Path(d) / 'a.md'
            f.write_text('x')
            code = publish.main(([str(f)] if with_file else []) + argv)
        return code, calls, out.getvalue(), err.getvalue()

    def test_create_sends_project_and_tags(self):
        code, calls, out, _ = self.run_main(['--project', 'Client Acme', '--tag', 'V2', '--tag', 'maquette'], ['[]', self.ART % 'a'])
        self.assertEqual(code, 0)
        self.assertIn('form-string = "project=client-acme"', calls[1])
        self.assertIn('form-string = "tags=maquette,v2"', calls[1])
        self.assertIn('project: acme', out)
        self.assertIn('tags: x', out)

    def test_create_without_labels_sends_none(self):
        _, calls, _, _ = self.run_main([], ['[]', self.ART % 'a'])
        self.assertNotIn('project=', calls[1])
        self.assertNotIn('tags=', calls[1])

    def test_update_clears_project_and_replaces_tags_only_when_given(self):
        existing = '[{"id":"1","slug":"a","visibility":"private","hasCode":false}]'
        _, calls, _, _ = self.run_main(['--project', ''], [existing, self.ART % 'a', self.ART % 'a'])
        self.assertIn('\\"project\\": null', calls[2])
        self.assertNotIn('tags', calls[2].split('request')[1])
        _, calls, _, _ = self.run_main(['--tag', 'Z'], [existing, self.ART % 'a', self.ART % 'a'])
        self.assertIn('\\"tags\\": [\\"z\\"]', calls[2])
        self.assertNotIn('project', calls[2].split('request')[1])

    def test_invalid_labels_exit_2_before_network(self):
        for argv in (['--project', '???'], ['--tag', '!!!']):
            code, calls, _, _ = self.run_main(argv, [])
            self.assertEqual((code, len(calls)), (2, 0), argv)

    def test_rename_slug_validation(self):
        for new in ('Bad Slug', 'admin', ''):
            code, calls, _, _ = self.run_main(['--rename-slug', new], [])
            self.assertEqual((code, len(calls)), (2, 0), new)
        code, calls, _, _ = self.run_main(['--slug', 'a', '--rename-slug', 'a'], [])
        self.assertEqual((code, len(calls)), (2, 0))

    def test_rename_requires_existing_artifact(self):
        code, calls, _, err = self.run_main(['--rename-slug', 'nouveau'], ['[]'])
        self.assertEqual((code, len(calls)), (2, 1))
        self.assertIn('existing artifact', err)

    def test_rename_taken_slug_rejected_before_upload(self):
        existing = '[{"id":"1","slug":"a","visibility":"private","hasCode":false}]'
        code, calls, _, _ = self.run_main(['--rename-slug', 'pris'], [existing, '{"slug":"pris","valid":true,"available":false}'])
        self.assertEqual((code, len(calls)), (2, 2))

    def test_rename_patches_slug_after_content_update(self):
        existing = '[{"id":"1","slug":"a","visibility":"private","hasCode":false}]'
        code, calls, out, _ = self.run_main(['--rename-slug', 'nouveau'],
                                            [existing, '{"slug":"nouveau","valid":true,"available":true}', self.ART % 'a', self.ART % 'nouveau'])
        self.assertEqual(code, 0)
        self.assertIn('request = "PUT"', calls[2])
        self.assertIn('request = "PATCH"', calls[3])
        self.assertIn('\\"slug\\": \\"nouveau\\"', calls[3])
        self.assertIn('no longer works', out)

    def test_rename_failure_after_update_reports_old_url(self):
        existing = '[{"id":"1","slug":"a","visibility":"private","hasCode":false}]'
        calls = []
        responses = [(existing, 200), ('{"slug":"nouveau","valid":true,"available":true}', 200), (self.ART % 'a', 200), ('{"error":"boom"}', 500)]

        def fake_run(a, **kw):
            calls.append(kw['input'])
            body, status = responses[len(calls) - 1]
            return mock.Mock(returncode=0, stdout=f'{body}\n{status}', stderr='')

        err = io.StringIO()
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', fake_run), \
                redirect_stdout(io.StringIO()), mock.patch('sys.stderr', err):
            f = Path(d) / 'a.md'
            f.write_text('x')
            code = publish.main([str(f), '--rename-slug', 'nouveau'])
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 4)
        self.assertIn('old URL u', err.getvalue())
        self.assertIn('boom', err.getvalue())
        self.assertIn('--slug a --rename-slug nouveau', err.getvalue())

    def test_list_projects_needs_no_path(self):
        code, calls, out, _ = self.run_main(['--list-projects'], ['[{"name":"acme","count":2},{"name":null,"count":1}]'], with_file=False)
        self.assertEqual((code, len(calls)), (0, 1))
        self.assertIn('/api/projects', calls[0])
        self.assertIn('acme\t2', out)
        self.assertIn('(no folder)\t1', out)

    def test_path_required_without_list_projects(self):
        with self.assertRaises(SystemExit), mock.patch('sys.stderr', io.StringIO()):
            publish.parse_args([])

    def test_dry_run_shows_labels(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, self.ENV), redirect_stdout(io.StringIO()) as out:
            f = Path(d) / 'a.md'
            f.write_text('x')
            self.assertEqual(publish.main([str(f), '--dry-run', '--project', 'Acme', '--tag', 'x', '--rename-slug', 'nouveau']), 0)
        text = out.getvalue()
        self.assertIn('"project": "acme"', text)
        self.assertIn('"tags": ["x"]', text)
        self.assertIn('nouveau', text)


class VersionsTest(unittest.TestCase):
    ENV = {'ARTIFACT_HUB_TOKEN': TOKEN, 'ARTIFACT_HUB_URL': 'https://h.example'}
    ART = '{"id":"A1","slug":"%s","title":"t","visibility":"private","url":"u","project":null,"tags":[],"version":{"number":%d}}'
    VERSIONS = ('[{"id":"V2","number":2,"kind":"site","originalName":"b.zip","sizeBytes":20,"createdAt":"2026-02-01T00:00:00.000Z","current":true},'
                '{"id":"V1","number":1,"kind":"html","originalName":"a.html","sizeBytes":10,"createdAt":"2026-01-01T00:00:00.000Z","current":false}]')

    def run_main(self, argv, responses):
        calls = []

        def fake_run(a, **kw):
            calls.append(kw['input'])
            return mock.Mock(returncode=0, stdout=responses[len(calls) - 1] + '\n200', stderr='')

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', fake_run), redirect_stdout(out), mock.patch('sys.stderr', err):
            code = publish.main(argv)
        return code, calls, out.getvalue(), err.getvalue()

    def test_restore_validation(self):
        for bad in (['--restore', '0', '--slug', 'a'], ['--restore', '-2', '--slug', 'a'], ['--restore', 'x', '--slug', 'a'], ['--restore', '1']):
            with self.assertRaises(SystemExit, msg=bad), mock.patch('sys.stderr', io.StringIO()):
                publish.parse_args(bad)
        with self.assertRaises(SystemExit), mock.patch('sys.stderr', io.StringIO()):
            publish.parse_args(['--restore', '1', '--list-versions', '--slug', 'a'])
        with self.assertRaises(SystemExit), mock.patch('sys.stderr', io.StringIO()):
            publish.parse_args(['--list-versions'])

    def test_list_versions_by_slug(self):
        code, calls, out, _ = self.run_main(['--list-versions', '--slug', 'demo'], ['[%s]' % (self.ART % ('demo', 2)), self.VERSIONS])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn('url = "https://h.example/api/artifacts?slug=demo"', calls[0])
        self.assertIn('url = "https://h.example/api/artifacts/A1/versions"', calls[1])
        self.assertIn('v2\t2026-02-01T00:00:00.000Z\tsite\tb.zip\t20\t* current', out)
        self.assertIn('v1\t2026-01-01T00:00:00.000Z\thtml\ta.html\t10', out)
        self.assertNotIn(TOKEN, out)

    def test_list_versions_slug_derived_from_path(self):
        _, calls, _, _ = self.run_main(['--list-versions', '/nowhere/Mon Rapport.md'], ['[%s]' % (self.ART % ('mon-rapport', 2)), '[]'])
        self.assertIn('slug=mon-rapport', calls[0])

    def test_restore_builds_post_and_prints_summary(self):
        code, calls, out, _ = self.run_main(['--restore', '1', '--slug', 'demo'], ['[%s]' % (self.ART % ('demo', 2)), self.VERSIONS, self.ART % ('demo', 1)])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 3, 'pas d’envoi de fichier')
        self.assertIn('request = "POST"', calls[2])
        self.assertIn('url = "https://h.example/api/artifacts/A1/versions/V1/restore"', calls[2])
        self.assertNotIn('form', calls[2])
        self.assertIn('restored: t', out)
        self.assertIn('version: v1', out)
        self.assertNotIn(TOKEN, calls[2].replace('Authorization: Bearer ' + TOKEN, ''))

    def test_restore_unknown_version_and_unknown_slug(self):
        code, calls, _, err = self.run_main(['--restore', '9', '--slug', 'demo'], ['[%s]' % (self.ART % ('demo', 2)), self.VERSIONS])
        self.assertEqual((code, len(calls)), (1, 2))
        self.assertIn('v9', err)
        code, calls, _, err = self.run_main(['--restore', '1', '--slug', 'demo'], ['[]'])
        self.assertEqual((code, len(calls)), (1, 1))
        self.assertIn('No artifact', err)

    def test_dry_run_makes_no_network_call(self):
        for argv in (['--restore', '1', '--slug', 'demo', '--dry-run'], ['--list-versions', '--slug', 'demo', '--dry-run']):
            code, calls, out, _ = self.run_main(argv, [])
            self.assertEqual((code, calls), (0, []), argv)
            self.assertIn('[dry-run]', out)
            self.assertNotIn(TOKEN, out)
        _, _, out, _ = self.run_main(['--restore', '2', '--slug', 'demo', '--dry-run'], [])
        self.assertIn('POST', out)
        self.assertIn('v2', out)

    def test_bad_combinations_exit_2_with_zero_calls(self):
        combos = [
            ['--restore', '1', '--slug', 'a', '--visibility', 'public'], ['--restore', '1', '--slug', 'a', '--title', 'x'],
            ['--restore', '1', '--slug', 'a', '--code', 'secret1'], ['--restore', '1', '--slug', 'a', '--project', 'p'],
            ['--list-versions', '--slug', 'a', '--tag', 't'], ['--list-versions', '--slug', 'a', '--rename-slug', 'b'],
            ['--restore', '1', '--slug', 'a', '--link-hours', '2'], ['--restore', '1', '--slug', 'a', '--link-label', 'l'],
            ['--restore', '1', '--slug', 'a', '--memory-storage'], ['--restore', '1', '--slug', 'a', '--no-memory-storage'],
            ['--list-versions', '--slug', 'a', '--include-dotfiles'],
            ['--list-versions', '--restore', '1', '--slug', 'a'], ['--list-projects', '--restore', '1', '--slug', 'a'],
            ['--list-projects', '--list-versions', '--slug', 'a'],
        ]
        for argv in combos:
            calls = []
            with mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', lambda a, **kw: calls.append(1)), \
                    mock.patch('sys.stderr', io.StringIO()) as err, self.assertRaises(SystemExit) as cm:
                publish.main(argv)
            self.assertEqual((cm.exception.code, calls), (2, []), argv)
            self.assertTrue(err.getvalue(), argv)

    def test_invalid_slug_exits_2_before_network(self):
        code, calls, _, _ = self.run_main(['--restore', '1', '--slug', 'Pas Valide'], [])
        self.assertEqual((code, calls), (2, []))

    def test_create_and_update_print_version(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'a.md'
            f.write_text('x')
            _, _, out, _ = self.run_main([str(f)], ['[]', self.ART % ('a', 1)])
            self.assertIn('version: v1', out)
            _, _, out, _ = self.run_main([str(f)], ['[%s]' % (self.ART % ('a', 1)), self.ART % ('a', 3)])
            self.assertIn('version: v3', out)


class StatsTest(unittest.TestCase):
    ENV = VersionsTest.ENV
    ART = VersionsTest.ART
    STATS = ('{"total":{"views":124,"uniques":98},"lastVisitAt":"2026-11-12T08:30:00.000Z",'
             '"days":[' + ','.join('{"day":"2026-11-%02d","views":%d,"uniques":%d}' % (6 + i, i, max(i - 1, 0)) for i in range(7)) + '],'
             '"links":[{"id":"L1","label":"Client","openCount":12,"lastUsedAt":"2026-11-12T08:29:00.000Z","active":true},'
             '{"id":"L2","label":null,"openCount":0,"lastUsedAt":null,"active":false}]}')
    run_main = VersionsTest.run_main

    def test_stats_by_slug_prints_totals_days_and_links(self):
        code, calls, out, _ = self.run_main(['--stats', '--slug', 'demo'], ['[%s]' % (self.ART % ('demo', 2)), self.STATS])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn('url = "https://h.example/api/artifacts?slug=demo"', calls[0])
        self.assertIn('url = "https://h.example/api/artifacts/A1/stats?days=7"', calls[1])
        self.assertIn('request = "GET"', calls[1])
        self.assertIn('views: 124', out)
        self.assertIn('uniques: 98', out)
        self.assertIn('last-visit: 2026-11-12T08:30:00.000Z', out)
        self.assertIn('2026-11-06\t0\t0', out)
        self.assertIn('2026-11-12\t6\t5', out)
        self.assertLess(out.index('2026-11-06\t'), out.index('2026-11-12\t'))
        self.assertIn('Client\t12\tactive\t2026-11-12T08:29:00.000Z', out)
        self.assertIn('(no label)\t0\tinactive\t-', out)
        self.assertNotIn(TOKEN, out)

    def test_stats_without_visits_or_links(self):
        empty = '{"total":{"views":0,"uniques":0},"lastVisitAt":null,"days":[],"links":[]}'
        code, calls, out, _ = self.run_main(['--stats', '/nowhere/Mon Rapport.md'], ['[%s]' % (self.ART % ('mon-rapport', 1)), empty])
        self.assertEqual(code, 0)
        self.assertIn('slug=mon-rapport', calls[0])
        self.assertIn('views: 0', out)
        self.assertIn('last-visit: -', out)
        self.assertIn('links: -', out)

    def test_stats_unknown_slug(self):
        code, calls, _, err = self.run_main(['--stats', '--slug', 'demo'], ['[]'])
        self.assertEqual((code, len(calls)), (1, 1))
        self.assertIn('No artifact', err)

    def test_stats_dry_run_makes_no_network_call(self):
        code, calls, out, _ = self.run_main(['--stats', '--slug', 'demo', '--dry-run'], [])
        self.assertEqual((code, calls), (0, []))
        self.assertIn('[dry-run]', out)
        self.assertIn('/stats?days=7', out)

    def test_stats_bad_combinations_exit_2(self):
        for argv in (['--stats'], ['--stats', '--slug', 'a', '--tag', 't'], ['--stats', '--slug', 'a', '--visibility', 'public'],
                     ['--stats', '--list-versions', '--slug', 'a'], ['--stats', '--restore', '1', '--slug', 'a'], ['--stats', '--list-projects']):
            calls = []
            with mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', lambda a, **kw: calls.append(1)), \
                    mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit) as cm:
                publish.main(argv)
            self.assertEqual((cm.exception.code, calls), (2, []), argv)


class FolderTest(unittest.TestCase):
    ENV = VersionsTest.ENV
    run_main = VersionsTest.run_main
    DETAIL = ('{"name":"acme","title":null,"visibility":"%s","hasCode":%s,"url":"https://c.example/d/acme","activeLinkUrl":null,'
              '"count":3,"privateCount":%d,"artifacts":[],"links":[]}')
    SHARE = ('{"project":{"name":"acme","visibility":"link","url":"https://c.example/d/acme","count":3,"privateCount":1},'
             '"link":{"id":"L1","url":"https://c.example/share/TOK","expiresAt":"2026-11-15T10:00:00.000Z"}}')

    def test_list_projects_shows_folder_visibility_and_private_count(self):
        code, calls, out, _ = self.run_main(['--list-projects'], [
            '[{"name":"acme","count":3,"privateCount":1,"visibility":"link","title":"Acme"},'
            '{"name":"vide","count":0,"privateCount":0,"visibility":"private","title":null},'
            '{"name":null,"count":2,"privateCount":2,"visibility":"private","title":null}]'])
        self.assertEqual((code, len(calls)), (0, 1))
        self.assertIn('acme\t3\tlink\t1', out)
        self.assertIn('vide\t0\tprivate\t0', out)
        self.assertIn('(no folder)\t2\t-\t2', out)

    def test_share_folder_by_link_default_7_days(self):
        code, calls, out, err = self.run_main(['--share-folder', 'Acme'], [self.DETAIL % ('private', 'false', 1), self.SHARE])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn('url = "https://h.example/api/projects/acme"', calls[0])
        self.assertIn('request = "POST"', calls[1])
        self.assertIn('url = "https://h.example/api/projects/acme/share"', calls[1])
        self.assertIn('\\"hours\\": 168', calls[1])
        self.assertIn('folder: acme', out)
        self.assertIn('visibility: link', out)
        self.assertIn('url: https://c.example/d/acme', out)
        self.assertIn('share: https://c.example/share/TOK', out)
        self.assertIn('share-expires: 2026-11-15T10:00:00.000Z', out)
        self.assertIn('1 private artifact', err, 'garde-fou : les privés deviennent visibles via le dossier')
        self.assertNotIn(TOKEN, out + err)

    def test_share_folder_link_hours_and_label(self):
        _, calls, _, _ = self.run_main(['--share-folder', 'acme', '--link-hours', '24', '--link-label', 'Client'],
                                       [self.DETAIL % ('link', 'false', 0), self.SHARE])
        self.assertIn('\\"hours\\": 24', calls[1])
        self.assertIn('\\"label\\": \\"Client\\"', calls[1])

    def test_share_folder_public_or_code_patches_visibility(self):
        code, calls, out, _ = self.run_main(['--share-folder', 'acme', '--visibility', 'public', '--title', 'Acme T4'],
                                            [self.DETAIL % ('private', 'false', 0), self.DETAIL % ('public', 'false', 0)])
        self.assertEqual(code, 0)
        self.assertIn('request = "PATCH"', calls[1])
        self.assertIn('\\"visibility\\": \\"public\\"', calls[1])
        self.assertIn('\\"title\\": \\"Acme T4\\"', calls[1])
        self.assertIn('url: https://c.example/d/acme', out)
        self.assertNotIn('share:', out)
        code, calls, _, _ = self.run_main(['--share-folder', 'acme', '--visibility', 'code', '--code', 'sesame-long'],
                                          [self.DETAIL % ('private', 'false', 0), self.DETAIL % ('code', 'true', 0)])
        self.assertEqual(code, 0)
        self.assertIn('\\"code\\": \\"sesame-long\\"', calls[1])

    def test_share_folder_code_required_unless_folder_has_one(self):
        code, calls, _, err = self.run_main(['--share-folder', 'acme', '--visibility', 'code'], [self.DETAIL % ('private', 'false', 0)])
        self.assertEqual((code, len(calls)), (2, 1))
        self.assertIn('--code', err)
        code, calls, _, _ = self.run_main(['--share-folder', 'acme', '--visibility', 'code'],
                                          [self.DETAIL % ('code', 'true', 0), self.DETAIL % ('code', 'true', 0)])
        self.assertEqual((code, len(calls)), (0, 2))

    def test_share_folder_private_unshares(self):
        code, calls, out, err = self.run_main(['--share-folder', 'acme', '--visibility', 'private'],
                                              [self.DETAIL % ('link', 'false', 2), self.DETAIL % ('private', 'false', 2)])
        self.assertEqual(code, 0)
        self.assertIn('\\"visibility\\": \\"private\\"', calls[1])
        self.assertIn('visibility: private', out)
        self.assertNotIn('private', err, 'pas d’avertissement en retirant le partage')

    def test_share_folder_dry_run_and_bad_combinations(self):
        code, calls, out, _ = self.run_main(['--share-folder', 'acme', '--dry-run'], [])
        self.assertEqual((code, calls), (0, []))
        self.assertIn('/api/projects/acme/share', out)
        for argv in (['--share-folder', '!!!'], ['--share-folder', 'acme', '--tag', 't'], ['--share-folder', 'acme', '--slug', 's'],
                     ['--share-folder', 'acme', '--code', 'sesame-long'], ['--share-folder', 'acme', '--visibility', 'public', '--link-hours', '2'],
                     ['--share-folder', 'acme', '--list-projects'], ['--share-folder', 'acme', 'fichier.md'],
                     ['--folder-stats', 'acme', '--visibility', 'public'], ['--folder-stats', 'acme', '--stats', '--slug', 'a']):
            calls = []
            with mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', lambda a, **kw: calls.append(1)), \
                    mock.patch('sys.stderr', io.StringIO()) as err, self.assertRaises(SystemExit) as cm:
                publish.main(argv)
            self.assertEqual((cm.exception.code, calls), (2, []), argv)
            self.assertTrue(err.getvalue(), argv)

    def test_folder_stats(self):
        stats = StatsTest.STATS
        code, calls, out, _ = self.run_main(['--folder-stats', 'Acme'], [stats])
        self.assertEqual((code, len(calls)), (0, 1))
        self.assertIn('url = "https://h.example/api/projects/acme/stats?days=7"', calls[0])
        self.assertIn('folder: acme', out)
        self.assertIn('views: 124', out)
        self.assertIn('2026-11-12\t6\t5', out)
        self.assertIn('Client\t12\tactive\t2026-11-12T08:29:00.000Z', out)
        code, calls, out, _ = self.run_main(['--folder-stats', 'acme', '--dry-run'], [])
        self.assertEqual((code, calls), (0, []))
        self.assertIn('/api/projects/acme/stats?days=7', out)


class CreateFolderTest(unittest.TestCase):
    ENV = VersionsTest.ENV
    CREATED = ('{"name":"client-acme","title":"Acme","description":"Maquettes T4","visibility":"private","hasCode":false,"hasSheet":true,'
               '"url":"https://c.example/d/client-acme","activeLinkUrl":null,"count":0,"privateCount":0,"artifacts":[],"links":[]}')

    def run_main(self, argv, responses):
        calls = []

        def fake_run(a, **kw):
            calls.append(kw['input'])
            body, status = responses[len(calls) - 1]
            return mock.Mock(returncode=0, stdout=f'{body}\n{status}', stderr='')

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', fake_run), redirect_stdout(out), mock.patch('sys.stderr', err):
            code = publish.main(argv)
        return code, calls, out.getvalue(), err.getvalue()

    def test_create_folder_posts_normalised_name_and_prints_state(self):
        code, calls, out, err = self.run_main(['--create-folder', 'Client Acme', '--title', 'Acme', '--description', 'Maquettes T4'],
                                              [(self.CREATED, 201)])
        self.assertEqual((code, len(calls)), (0, 1))
        self.assertIn('request = "POST"', calls[0])
        self.assertIn('url = "https://h.example/api/projects"', calls[0])
        self.assertIn('\\"name\\": \\"client-acme\\"', calls[0])
        self.assertIn('\\"title\\": \\"Acme\\"', calls[0])
        self.assertIn('\\"description\\": \\"Maquettes T4\\"', calls[0])
        for line in ('folder: client-acme', 'title: Acme', 'description: Maquettes T4', 'visibility: private', 'artifacts: 0', 'url: https://c.example/d/client-acme'):
            self.assertIn(line, out)
        self.assertNotIn(TOKEN, out + err)

    def test_create_folder_without_title_sends_name_only(self):
        created = self.CREATED.replace('"title":"Acme"', '"title":null').replace('"description":"Maquettes T4"', '"description":null')
        code, calls, out, _ = self.run_main(['--create-folder', 'client-acme'], [(created, 201)])
        self.assertEqual(code, 0)
        self.assertNotIn('title', calls[0].split('data = ', 1)[1])
        self.assertNotIn('description', calls[0].split('data = ', 1)[1])
        self.assertNotIn('title:', out)

    def test_create_folder_conflict_is_explained(self):
        code, calls, out, err = self.run_main(['--create-folder', 'acme'], [('{"error":"Un dossier porte déjà ce nom"}', 409)])
        self.assertEqual((code, len(calls)), (1, 1))
        self.assertEqual(out, '')
        self.assertIn('“acme” already exists', err)
        self.assertIn('--list-projects', err)

    def test_create_folder_dry_run(self):
        code, calls, out, _ = self.run_main(['--create-folder', 'Client Acme', '--dry-run'], [])
        self.assertEqual((code, calls), (0, []))
        self.assertIn('POST', out)
        self.assertIn('/api/projects', out)
        self.assertIn('client-acme', out)

    def test_create_folder_bad_combinations(self):
        for argv in (['--create-folder', '!!!'], ['--create-folder', 'a', '--visibility', 'public'], ['--create-folder', 'a', 'fichier.md'],
                     ['--create-folder', 'a', '--share-folder', 'a'], ['--create-folder', 'a', '--tag', 't'], ['--create-folder', 'a', '--list-projects'],
                     ['--create-folder', 'a', '--code', 'sesame-long'], ['--description', 'x', 'fichier.md'], ['--create-folder', 'a', '--description', 'x' * 1001],
                     ['--create-folder', 'a', '--title', 'x' * 121]):
            calls = []
            with mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', lambda a, **kw: calls.append(1)), \
                    mock.patch('sys.stderr', io.StringIO()) as err, self.assertRaises(SystemExit) as cm:
                publish.main(argv)
            self.assertEqual((cm.exception.code, calls), (2, []), argv)
            self.assertTrue(err.getvalue(), argv)


class ThumbnailTest(unittest.TestCase):
    ENV = {'ARTIFACT_HUB_TOKEN': TOKEN, 'ARTIFACT_HUB_URL': 'https://h.example'}
    ART = '{"id":"A1","slug":"a","title":"t","kind":"%s","visibility":"private","url":"u","project":null,"tags":[],"version":{"id":"V9","number":2}}'
    PREVIEW = '{"url":"https://c.example/a/a/SIG/index.html"}'
    AB = '/opt/bin/agent-browser'
    CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

    def tools(self, *names):
        paths = {'agent-browser': self.AB, 'cwebp': '/opt/bin/cwebp', 'magick': '/opt/bin/magick', 'sips': '/usr/bin/sips'}
        return mock.patch('shutil.which', lambda n: paths[n] if n in names else None)

    def run_main(self, argv, api_responses, tools=('agent-browser', 'cwebp'), fail=None, big=False, with_file=True, chrome=False):
        """subprocess.run simulé : curl répond depuis `api_responses`, les outils d'image écrivent leurs fichiers."""
        curl_calls, argvs = [], []
        self.timeouts = []

        def fake_run(a, **kw):
            argvs.append(list(a))
            self.timeouts.append((os.path.basename(a[0]), kw.get('timeout')))
            if a[0] == 'curl':
                curl_calls.append(kw['input'])
                r = api_responses[len(curl_calls) - 1]
                body, status = r if isinstance(r, tuple) else (r, 200)
                return mock.Mock(returncode=0, stdout=f'{body}\n{status}', stderr='')
            name = os.path.basename(a[0])
            if fail and fail in a:
                return mock.Mock(returncode=1, stdout='', stderr='boom')
            if name == 'agent-browser' and 'screenshot' in a:
                Path(a[-1]).write_bytes(b'\x89PNG\r\n\x1a\n' + b'0' * 64)
            elif name == 'Google Chrome':
                Path(next(x for x in a if x.startswith('--screenshot=')).split('=', 1)[1]).write_bytes(b'\x89PNG\r\n\x1a\n' + b'0' * 64)
            elif name == 'cwebp':
                Path(a[a.index('-o') + 1]).write_bytes(b'RIFF\0\0\0\0WEBPVP8 ' + (b'0' * (3 * 1024 * 1024) if big else b'0' * 64))
            elif name == 'sips':
                Path(a[a.index('--out') + 1]).write_bytes(b'\xff\xd8\xff\xe0' + b'0' * 64)
            return mock.Mock(returncode=0, stdout='', stderr='')

        out, err = io.StringIO(), io.StringIO()
        access = (lambda p, m: p == self.CHROME) if chrome else (lambda p, m: False)
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', fake_run), \
                self.tools(*tools), mock.patch('os.access', access), redirect_stdout(out), mock.patch('sys.stderr', err):
            f = Path(d) / 'a.html'
            f.write_text('<p>x</p>')
            code = publish.main(([str(f)] if with_file else []) + argv)
        return code, curl_calls, argvs, out.getvalue(), err.getvalue()

    def test_create_captures_with_agent_browser_and_uploads_webp(self):
        code, curl, argvs, out, err = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW, '{"thumbnailUrl":"/x"}'])
        self.assertEqual(code, 0, err)
        self.assertIn('url = "https://h.example/api/artifacts/A1/versions/V9/preview"', curl[2])
        put = curl[3]
        self.assertIn('request = "PUT"', put)
        self.assertIn('url = "https://h.example/api/artifacts/A1/versions/V9/thumbnail"', put)
        self.assertIn('header = "Content-Type: image/webp"', put)
        self.assertRegex(put, r'data-binary = "@[^"]+\.webp"')
        ab = [a for a in argvs if a[0] == self.AB]
        self.assertEqual(ab[0], [self.AB, '--session', SESSION, 'set', 'viewport', '1280', '800', '1'])
        self.assertEqual(ab[1], [self.AB, '--session', SESSION, 'set', 'media', 'light'], 'capture indépendante de l’apparence du Mac')
        self.assertEqual(ab[2], [self.AB, '--session', SESSION, 'open', 'https://c.example/a/a/SIG/index.html'])
        self.assertEqual(ab[3], [self.AB, '--session', SESSION, 'wait', '--load', 'load'])
        self.assertEqual(ab[4], [self.AB, '--session', SESSION, 'wait', '1500'])
        self.assertEqual(ab[5][:4], [self.AB, '--session', SESSION, 'eval'], 'barres de défilement masquées comme --hide-scrollbars')
        self.assertIn('scrollbar-width', ab[5][4])
        self.assertEqual(ab[6][:4], [self.AB, '--session', SESSION, 'screenshot'])
        self.assertEqual(ab[-1], [self.AB, '--session', SESSION, 'close'])
        cwebp = next(a for a in argvs if a[0] == '/opt/bin/cwebp')
        self.assertEqual(cwebp[:6], ['/opt/bin/cwebp', '-quiet', '-q', '80', '-resize', '960'])
        self.assertIn('thumbnail: ok', out)
        for a in argvs:
            self.assertNotIn(TOKEN, ' '.join(a))
        self.assertNotIn(TOKEN, out + err)
        self.assertNotIn('SIG', out + err)

    def test_chrome_fallback_command_and_png_upload_without_converter(self):
        code, curl, argvs, out, err = self.run_main([], ['[]', self.ART % 'markdown', self.PREVIEW, '{}'], tools=(), chrome=True)
        self.assertEqual(code, 0, err)
        chrome = next(a for a in argvs if a[0] == self.CHROME)
        self.assertIn('--headless=new', chrome)
        self.assertIn('--window-size=1280,800', chrome)
        self.assertIn('--hide-scrollbars', chrome)
        self.assertIn('--force-device-scale-factor=1', chrome)
        self.assertIn('--virtual-time-budget=2000', chrome)
        self.assertIn('--blink-settings=preferredColorScheme=1', chrome, 'thème clair forcé')
        self.assertTrue(any(x.startswith('--user-data-dir=') for x in chrome), 'profil jetable, jamais celui de l’utilisateur')
        self.assertTrue(any(x.startswith('--screenshot=') for x in chrome))
        self.assertEqual(chrome[-1], 'https://c.example/a/a/SIG/index.html')
        self.assertIn('header = "Content-Type: image/png"', curl[3])

    def test_sips_converts_to_jpeg_when_no_webp_encoder(self):
        code, curl, argvs, _, err = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW, '{}'], tools=('agent-browser', 'sips'))
        self.assertEqual(code, 0, err)
        sips = next(a for a in argvs if a[0] == '/usr/bin/sips')
        self.assertEqual(sips[:7], ['/usr/bin/sips', '-z', '600', '960', '-s', 'format', 'jpeg'])
        self.assertIn('header = "Content-Type: image/jpeg"', curl[3])

    def test_capture_failure_never_fails_the_publish(self):
        code, curl, argvs, out, err = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW], fail='screenshot')
        self.assertEqual(code, 0)
        self.assertIn('created: t', out)
        self.assertIn('url: u', out)
        self.assertEqual(len(curl), 3, 'aucun envoi de miniature')
        self.assertEqual(argvs[-1], [self.AB, '--session', SESSION, 'close'], 'session fermée même après un échec')
        self.assertEqual(len([l for l in err.splitlines() if l.strip()]), 1)
        self.assertIn('thumbnail', err)
        self.assertIn('--thumbnail-only', err)

    def test_upload_failure_and_no_browser_only_warn(self):
        code, _, _, out, err = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW, ('{"error":"Miniature refusée"}', 415)])
        self.assertEqual(code, 0)
        self.assertIn('created: t', out)
        self.assertNotIn('thumbnail: ok', out)
        self.assertIn('HTTP 415', err)
        code, curl, _, out, err = self.run_main([], ['[]', self.ART % 'html'], tools=())
        self.assertEqual(code, 0)
        self.assertEqual(len(curl), 2, 'pas d’aperçu demandé sans navigateur')
        self.assertIn('no browser found', err)

    def test_oversized_result_is_not_uploaded(self):
        code, curl, _, _, err = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW], big=True)
        self.assertEqual((code, len(curl)), (0, 3))
        self.assertIn('2 MiB', err)

    def test_no_thumbnail_flag_and_pdf_skip_capture(self):
        code, curl, argvs, out, _ = self.run_main(['--no-thumbnail'], ['[]', self.ART % 'html'])
        self.assertEqual((code, len(curl)), (0, 2))
        self.assertEqual([a for a in argvs if a[0] != 'curl'], [])
        code, curl, argvs, out, err = self.run_main([], ['[]', self.ART % 'pdf'])
        self.assertEqual((code, len(curl), err), (0, 2, ''))
        self.assertEqual([a for a in argvs if a[0] != 'curl'], [])

    def test_update_captures_the_new_version(self):
        existing = '[{"id":"A1","slug":"a","visibility":"private","hasCode":false}]'
        code, curl, _, _, err = self.run_main([], [existing, self.ART % 'html', self.PREVIEW, '{}'])
        self.assertEqual(code, 0, err)
        self.assertIn('request = "PUT"', curl[1])
        self.assertIn('/versions/V9/preview', curl[2])
        self.assertIn('/versions/V9/thumbnail', curl[3])

    def test_thumbnail_only_regenerates_without_uploading_content(self):
        code, curl, _, out, err = self.run_main(['--thumbnail-only', '--slug', 'a'], ['[%s]' % (self.ART % 'site'), self.PREVIEW, '{}'], with_file=False)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(curl), 3)
        self.assertIn('?slug=a', curl[0])
        self.assertNotIn('form', ''.join(curl))
        self.assertNotIn('/content', ''.join(curl))
        self.assertIn('/versions/V9/thumbnail', curl[2])
        self.assertIn('thumbnail: ok', out)

    def test_thumbnail_only_failures_exit_1(self):
        code, _, _, _, err = self.run_main(['--thumbnail-only', '--slug', 'a'], ['[%s]' % (self.ART % 'pdf')], with_file=False)
        self.assertEqual(code, 1)
        self.assertIn('PDF', err)
        code, _, _, _, err = self.run_main(['--thumbnail-only', '--slug', 'a'], ['[%s]' % (self.ART % 'html'), self.PREVIEW], fail='screenshot', with_file=False)
        self.assertEqual(code, 1)

    def test_dry_run_mentions_thumbnail_without_calls(self):
        code, curl, argvs, out, _ = self.run_main(['--dry-run'], [])
        self.assertEqual((code, argvs), (0, []))
        self.assertIn('thumbnail', out)
        self.assertIn('agent-browser', out)
        _, _, _, out, _ = self.run_main(['--dry-run', '--no-thumbnail'], [])
        self.assertNotIn('PUT /api/artifacts/<id>/versions/<id>/thumbnail', out)
        code, _, argvs, out, _ = self.run_main(['--thumbnail-only', '--slug', 'a', '--dry-run'], [], with_file=False)
        self.assertEqual((code, argvs), (0, []))
        self.assertIn('thumbnail', out)

    def test_argument_handling(self):
        self.assertFalse(publish.parse_args(['x']).no_thumbnail)
        self.assertTrue(publish.parse_args(['x', '--no-thumbnail']).no_thumbnail)
        self.assertTrue(publish.parse_args(['--thumbnail-only', '--slug', 'a']).thumbnail_only)
        self.assertTrue(publish.parse_args(['--thumbnail-only', 'page.html']).thumbnail_only)
        for argv in (['--thumbnail-only'], ['--thumbnail-only', '--slug', 'a', '--no-thumbnail'], ['--thumbnail-only', '--slug', 'a', '--stats'],
                     ['--thumbnail-only', '--slug', 'a', '--visibility', 'public'], ['--thumbnail-only', '--slug', 'a', '--title', 't'],
                     ['--stats', '--slug', 'a', '--no-thumbnail'], ['--restore', '1', '--slug', 'a', '--thumbnail-only']):
            calls = []
            with mock.patch.dict(os.environ, self.ENV), mock.patch('subprocess.run', lambda a, **kw: calls.append(1)), \
                    mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit) as cm:
                publish.main(argv)
            self.assertEqual((cm.exception.code, calls), (2, []), argv)

    def test_session_name_is_per_run_and_only_it_is_closed(self):
        _, _, argvs, _, _ = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW, '{}'])
        sessions = {a[a.index('--session') + 1] for a in argvs if a[0] == self.AB}
        self.assertEqual(sessions, {f'publish-thumb-{os.getpid()}'})
        closes = [a for a in argvs if a[0] == self.AB and a[-1] == 'close']
        self.assertEqual(closes, [[self.AB, '--session', SESSION, 'close']], 'jamais close --all')

    def test_tool_steps_share_one_budget(self):
        _, _, _, _, err = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW, '{}'])
        steps = [t for name, t in self.timeouts if name != 'curl']
        self.assertTrue(steps and all(t is not None and 0 < t <= publish.THUMB_BUDGET_S for t in steps), steps)

    def test_exhausted_budget_stops_capture_but_closes_session_and_publishes(self):
        clock = iter([0.0, 0.0] + [publish.THUMB_BUDGET_S + 1] * 50)  # début, aperçu, puis budget épuisé
        with mock.patch('time.monotonic', lambda: next(clock)):
            code, curl, argvs, out, err = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW])
        self.assertEqual(code, 0)
        self.assertIn('created: t', out)
        self.assertIn('budget exceeded', err)
        self.assertEqual(len(curl), 3, 'aucun envoi de miniature')
        self.assertEqual([a for a in argvs if a[0] == self.AB], [[self.AB, '--session', SESSION, 'close']])

    def test_short_curl_max_time_for_thumbnail_calls_only(self):
        _, curl, _, _, _ = self.run_main([], ['[]', self.ART % 'html', self.PREVIEW, '{}'])
        self.assertIn(f'max-time = {publish.UPLOAD_TIMEOUT_S}', curl[1], 'envoi du contenu : 600 s')
        for cfg in (curl[2], curl[3]):
            m = re.search(r'max-time = (\d+)', cfg)
            self.assertTrue(m and 0 < int(m.group(1)) <= publish.THUMB_CURL_TIMEOUT_S, cfg)
        self.assertLessEqual(publish.THUMB_CURL_TIMEOUT_S, 30)

    def test_requires_python_310(self):
        src = Path(publish.__file__).read_text(encoding='utf-8')
        self.assertTrue(src.startswith('#!/usr/bin/env python3'))
        self.assertIn('sys.version_info < (3, 10)', src)

    def test_browser_discovery_order(self):
        with self.tools('agent-browser'), mock.patch('os.access', lambda p, m: True):
            self.assertEqual(publish.find_browser(), ('agent-browser', self.AB))
        with self.tools(), mock.patch('os.access', lambda p, m: 'Edge' in str(p) or 'Brave' in str(p)):
            kind, path = publish.find_browser()
            self.assertEqual(kind, 'chromium')
            self.assertIn('Microsoft Edge', path)
        with self.tools(), mock.patch('os.access', lambda p, m: False):
            self.assertIsNone(publish.find_browser())

    def test_curl_body_file_config(self):
        cfg = publish.curl_config(TOKEN, 'PUT', 'https://h.example/x', body_file=(Path('/tmp/a "b".webp'), 'image/webp'))
        self.assertIn('header = "Content-Type: image/webp"', cfg)
        self.assertIn('data-binary = "@/tmp/a \\"b\\".webp"', cfg)
        self.assertNotIn('form', cfg)


if __name__ == '__main__':
    unittest.main()
