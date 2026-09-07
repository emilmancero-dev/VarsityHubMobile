const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.join(
  __dirname,
  '..',
  '..',
  'node_modules',
  'metro',
  'node_modules',
  'image-size'
);

function replaceExactly(source, before, after, filePath) {
  if (source.includes(after)) return source;
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `[patch-image-size-dos] Expected one unpatched match in ${filePath}; found ${occurrences}`
    );
  }
  return source.replace(before, after);
}

function patchFile(relativePath, patches) {
  const filePath = path.join(packageRoot, relativePath);
  let source = fs.readFileSync(filePath, 'utf8');
  for (const [before, after] of patches) {
    source = replaceExactly(source, before, after, relativePath);
  }
  fs.writeFileSync(filePath, source, 'utf8');
}

function main() {
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== '1.2.1') {
    throw new Error(
      `[patch-image-size-dos] Review required for image-size ${manifest.version}; expected 1.2.1`
    );
  }

  patchFile('dist/types/icns.js', [
    [
      '        let imageSize = getImageSize(imageHeader[0]);\n        imageOffset += imageHeader[1];\n',
      '        let imageSize = getImageSize(imageHeader[0]);\n' +
        '        if (imageHeader[1] <= 0)\n' +
        "            throw new TypeError('Invalid ICNS image entry length');\n" +
        '        imageOffset += imageHeader[1];\n',
    ],
    [
      '            imageSize = getImageSize(imageHeader[0]);\n            imageOffset += imageHeader[1];\n',
      '            imageSize = getImageSize(imageHeader[0]);\n' +
        '            if (imageHeader[1] <= 0)\n' +
        "                throw new TypeError('Invalid ICNS image entry length');\n" +
        '            imageOffset += imageHeader[1];\n',
    ],
  ]);

  patchFile('dist/types/jxl.js', [
    [
      '        if (!jxlpBox)\n            break;\n        partialStreams.push',
      '        if (!jxlpBox || jxlpBox.size <= 0)\n            break;\n        partialStreams.push',
    ],
  ]);

  console.log('[patch-image-size-dos] Applied image-size parser loop guards');
}

main();
