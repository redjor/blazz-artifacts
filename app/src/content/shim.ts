// Simulates localStorage/sessionStorage inside the sandbox (without allow-same-origin, access throws SecurityError).
// Per-tab persistence through window.name: {"__hubStore":{"l":{...},"s":{...}}}. ES5, never throws.
export const STORAGE_SHIM = `(function(){
var W=window,state={l:Object.create(null),s:Object.create(null)};
function load(src){var out=Object.create(null);
if(src&&typeof src==='object'&&!Array.isArray(src)){var ks=Object.keys(src);for(var i=0;i<ks.length;i++){var v=src[ks[i]];if(typeof v==='string')out[ks[i]]=v;}}
return out;}
try{var p=JSON.parse(W.name);if(p&&typeof p==='object'&&p.__hubStore&&typeof p.__hubStore==='object'){
state.l=load(p.__hubStore.l);state.s=load(p.__hubStore.s);}}catch(e){}
function save(){try{W.name=JSON.stringify({__hubStore:state});}catch(e){}}
function has(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
function make(slot){
var api={
getItem:function(k){k=String(k);return has(state[slot],k)?String(state[slot][k]):null;},
setItem:function(k,v){state[slot][String(k)]=String(v);save();},
removeItem:function(k){delete state[slot][String(k)];save();},
clear:function(){state[slot]=Object.create(null);save();},
key:function(i){var ks=Object.keys(state[slot]);i=Number(i);return i>=0&&i<ks.length?ks[i]:null;}
};
Object.defineProperty(api,'length',{get:function(){return Object.keys(state[slot]).length;}});
return api;}
function install(name,slot){
try{void W[name];return;}catch(e){}
try{var s=make(slot);Object.defineProperty(W,name,{configurable:true,get:function(){return s;}});}catch(e){}}
install('localStorage','l');
install('sessionStorage','s');
})();`;

const HEAD = /<head(?:\s[^>]*)?>/i;
const HTML = /<html(?:\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;
const COMMENT = /<!--[\s\S]*?-->/g;

// Never before the doctype (quirks mode); HTML comments are skipped when looking for the insertion point.
export function injectShim(html: string): string {
  const tag = `<script>${STORAGE_SHIM}</script>`;
  const scan = html.replace(COMMENT, (m) => ' '.repeat(m.length));
  for (const re of [HEAD, HTML, DOCTYPE]) {
    const m = re.exec(scan);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
  }
  return tag + html;
}
