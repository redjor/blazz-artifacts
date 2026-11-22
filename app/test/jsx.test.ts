import assert from 'node:assert/strict';
import test from 'node:test';
import { compileComponent } from '../src/ingest/jsx.ts';

test('transforms TSX without executing it and resolves browser dependencies', async () => {
 const r = await compileComponent('import {useState} from "react"; export default function Demo(){const [n]=useState<number>(3);return <b>{n}</b>}', 'demo.tsx', '<demo>');
 assert.match(r.code,/useState/); assert.doesNotMatch(r.code,/useState<number>/);
 assert.match(r.html,/&lt;demo&gt;/); assert.match(r.html,/component.js/);
});
test('rejects invalid syntax, missing default and local/server imports', async () => {
 for (const code of ['export default <', 'export const x = 1', 'import x from "node:fs"; export default x', 'import x from "./secret"; export default x']) await assert.rejects(compileComponent(code,'demo.jsx','test'));
});
test('source is never inserted into HTML', async () => {
 const r=await compileComponent('export default () => <p>{"</script><script>alert(1)</script>"}</p>','demo.jsx','test');
 assert.doesNotMatch(r.html,/alert\(1\)/); assert.match(r.code,/alert\(1\)/);
});
