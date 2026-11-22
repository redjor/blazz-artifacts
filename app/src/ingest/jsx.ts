import { build } from 'esbuild';
import { HttpError } from '../http.ts';
import { escapeHtml } from './page.ts';

// Only transform uploaded text. Imports are external browser URLs: never read local files,
// resolve installed packages, fetch dependencies or evaluate the component on the server.
export async function compileComponent(source: string, name: string, title: string): Promise<{code: string; html: string}> {
  try {
    const result = await build({
      stdin: {contents: source, loader: name.toLowerCase().endsWith('.tsx') ? 'tsx' : 'jsx', sourcefile: 'component'},
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
      jsx: 'automatic', metafile: true, logLevel: 'silent', outfile: 'component.js',
      plugins: [{name:'browser-dependencies',setup(b) {
        b.onResolve({filter:/.*/}, args => {
          const p = args.path;
          if (/^react(?:-dom)?(?:\/|$)/.test(p)) return {path:p,external:true};
          if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:@[a-zA-Z0-9_.^~+-]+)?(?:\/[a-zA-Z0-9_.-]+)*$/.test(p) || p.startsWith('.')) {
            return {errors:[{text:'Use npm package imports. Relative files and server modules require a prebuilt ZIP.'}]};
          }
          return {path:`https://esm.sh/${p}?external=react,react-dom`,external:true};
        });
      }}],
    });
    if (!Object.values(result.metafile!.outputs).some(o => o.exports.includes('default'))) throw new Error('A default component export is required');
    const code = result.outputFiles[0].text;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<script type="importmap">{"imports":{"react":"https://esm.sh/react@19.2.0","react/":"https://esm.sh/react@19.2.0/","react-dom":"https://esm.sh/react-dom@19.2.0?external=react","react-dom/":"https://esm.sh/react-dom@19.2.0/"}}</script>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.17/dist/index.global.js"></script>
<style>body{margin:0;font-family:system-ui,sans-serif}#error{padding:24px;white-space:pre-wrap}</style></head><body><div id="root"></div><p id="error" role="alert" hidden></p>
<script type="module">
try {
const [React, {createRoot}, {default:Component}] = await Promise.all([import('react'), import('https://esm.sh/react-dom@19.2.0/client?external=react'), import('./component.js')]);
class Boundary extends React.Component { constructor(p){super(p);this.state={error:null}} static getDerivedStateFromError(error){return {error}} render(){return this.state.error ? React.createElement('pre',null,String(this.state.error)) : this.props.children} }
createRoot(document.getElementById('root')).render(React.createElement(Boundary,null,React.createElement(Component)));
} catch(error) { const el=document.getElementById('error');el.hidden=false;el.textContent='Unable to load component. Check your connection and package imports. '+String(error); }
</script></body></html>`;
    return {code,html};
  } catch {
    throw new HttpError(400, 'invalid_component');
  }
}
