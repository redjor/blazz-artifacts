import { createHash } from 'node:crypto';
import { LIGHT } from '../ingest/page.ts';

// Only this fixed script may execute in the opaque-origin print document.
export const PRINT_SCRIPT = "window.addEventListener('load',async()=>{await document.fonts.ready;window.print()})";
export const PRINT_CSP = `sandbox allow-scripts allow-modals; script-src 'sha256-${createHash('sha256').update(PRINT_SCRIPT).digest('base64')}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
export const PRINT_STYLES = `
@page{size:A4;margin:18mm 18mm 20mm}
@media print{
:root,html:has(#theme-toggle:checked){${LIGHT};--bg:#fff}
html,body{background:#fff!important;color:#1c1917!important;print-color-adjust:exact;-webkit-print-color-adjust:exact}
body{font-size:10.5pt;line-height:1.55}
.toolbar,.theme-toggle,.toc,.toc-btn{display:none!important}
.page{width:100%;max-width:none!important;margin:0;padding:0!important}
.reader-top{margin-bottom:8mm;break-after:avoid}
.client-brand img{height:12mm;max-width:38mm;object-fit:contain}
.doc-head{margin:0 0 9mm;padding:0 0 5mm;border-top:0;border-bottom:1pt solid var(--client-accent,var(--rule));break-inside:avoid;break-after:avoid}
.doc-title{font-size:27pt!important;line-height:1.12;color:var(--client-primary,#1c1917)!important;text-wrap:balance}
.prose{color:#2e2a27;line-height:1.55}
.prose h1,.prose h2,.prose h3,.prose h4{break-after:avoid;page-break-after:avoid;break-inside:avoid}
.prose h1,.prose h2{margin:7mm 0 4mm;font-size:16pt}
.prose h3{margin:5mm 0 3mm;font-size:12pt}
.prose p,.prose li{orphans:3;widows:3}
.prose p,.prose ul,.prose ol{margin-bottom:3.5mm}
.prose li{margin:1.5mm 0}
.prose a{color:var(--client-primary,#9a3412)!important}
.prose table{display:table!important;width:100%;font-size:9pt;overflow:visible;table-layout:fixed}
.prose th,.prose td{padding:2.5mm 3mm;overflow-wrap:anywhere}
.prose thead{display:table-header-group}.prose tr{break-inside:avoid}
.prose pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow:visible;font-size:8.5pt;padding:4mm;line-height:1.45}
.prose img,.prose figure,.prose blockquote,.prose .diagram{break-inside:avoid}
.prose img{max-height:220mm;object-fit:contain;margin:5mm auto}
.prose .diagram{width:100%;margin:5mm 0;translate:none;overflow:visible}
.prose .diagram svg{max-width:100%;max-height:220mm;height:auto}
.client-footer{margin-top:8mm;padding-top:3mm;font-size:8pt;break-inside:avoid;color:#78716c}
}
`;
export function printDocument(html: string): string {
  html = html.replace('</head>', `<style>${PRINT_STYLES}</style></head>`);
  const script = `<script>${PRINT_SCRIPT}</script>`;
  return html.includes('</body>') ? html.replace('</body>', `${script}</body>`) : html + script;
}
