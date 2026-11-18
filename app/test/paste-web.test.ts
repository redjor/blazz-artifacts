import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPaste, pastedFile } from '../web/src/paste.ts';

// Paste to publish (design 15): what the clipboard text is, and the file the publish dialog receives.

test('collage : HTML, JSON et Markdown reconnus ; texte court ou d’une ligne ignoré', () => {
  assert.equal(detectPaste('<!DOCTYPE html><html><head><title>A</title></head><body></body></html>'), 'html');
  assert.equal(detectPaste('<html lang="fr"><body><p>Accueil de la borne</p></body></html>'), 'html');
  assert.equal(detectPaste('<section class="hero"><h1>Bienvenue</h1></section>\n<style>.hero{}</style>'), 'html');
  assert.equal(detectPaste('{ "client": "Acme", "statut": "signé" }'), 'json');
  assert.equal(detectPaste('[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]'), 'json');
  assert.equal(detectPaste('# Bilan\n\nLe churn a baissé.'), 'markdown');
  assert.equal(detectPaste('{ pas du json mais assez long pour compter\nsur deux lignes }'), 'markdown', 'broken JSON over two lines: text');
  assert.equal(detectPaste('https://example.com/page'), null, 'a URL');
  assert.equal(detectPaste('mot'), null);
  assert.equal(detectPaste('   \n  '), null);
  assert.equal(detectPaste('Une seule ligne de texte assez longue pour passer le seuil'), null, 'one line of prose');
});

test('collage : nom du fichier tiré du titre du contenu, sinon du titre par défaut', () => {
  const html = pastedFile('<html><head><title>Maquette « accueil » / v2</title></head><body><p>x</p></body></html>', 'Collé');
  assert.equal(html?.name, 'Maquette « accueil » - v2.html', 'slashes cannot reach the file name');
  assert.equal(html?.type, 'text/html');
  const h1 = pastedFile('<main><h1>Tableau <em>de bord</em></h1><p>chiffres</p></main>', 'Collé');
  assert.equal(h1?.name, 'Tableau de bord.html');
  assert.equal(pastedFile('# Compte rendu\n\nTexte.', 'Collé')?.name, 'Compte rendu.md');
  assert.equal(pastedFile('Intro du document\n\n## Section suivante', 'Collé le 18 nov.')?.name, 'Collé le 18 nov..md');
  assert.equal(pastedFile('{"a": 1, "b": [1, 2, 3, 4]}', 'Données')?.name, 'Données.json');
  assert.equal(pastedFile('court', 'x'), null);
});

test('collage : le contenu du fichier est le texte collé, tel quel', async () => {
  const text = '# Titre\n\nAccents : é à ü — emoji 🙂\n';
  const file = pastedFile(text, 'x')!;
  assert.equal(await file.text(), text);
});
