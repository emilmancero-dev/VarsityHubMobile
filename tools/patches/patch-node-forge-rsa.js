const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.join(__dirname, '..', '..', 'node_modules', 'node-forge');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
if (manifest.version !== '1.4.0') {
  throw new Error(
    `[patch-node-forge-rsa] Review required for node-forge ${manifest.version}; expected 1.4.0`
  );
}

const filePath = path.join(packageRoot, 'lib', 'rsa.js');
const before = `          if(!asn1.validate(obj, digestInfoValidator, capture, errors) ||
            obj.value.length !== 2) {`;
const after = `          if(!asn1.validate(obj, digestInfoValidator, capture, errors) ||
            obj.value.length !== 2 ||
            obj.value[0].value.length < 1 ||
            obj.value[0].value.length > 2) {`;
const source = fs.readFileSync(filePath, 'utf8');

if (source.includes(after)) {
  console.log('[patch-node-forge-rsa] RSA DigestAlgorithm guard already applied');
} else {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `[patch-node-forge-rsa] Expected one unpatched RSA verifier match; found ${occurrences}`
    );
  }
  fs.writeFileSync(filePath, source.replace(before, after), 'utf8');
  console.log('[patch-node-forge-rsa] Applied RSA DigestAlgorithm guard');
}
