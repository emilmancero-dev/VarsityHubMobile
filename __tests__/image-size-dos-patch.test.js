const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const packageRoot = path.join(
  __dirname,
  '..',
  'node_modules',
  'metro',
  'node_modules',
  'image-size'
);

function loadCommonJs(relativePath, requireOverrides = {}) {
  const filename = path.join(packageRoot, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const localRequire = request =>
    requireOverrides[request] || require(path.join(path.dirname(filename), request));
  vm.runInNewContext(`(function (exports, require, module) {${source}\n})`, {}, { filename })(
    module.exports,
    localRequire,
    module
  );
  return module.exports;
}

describe('patched image-size parser guards', () => {
  test('rejects a zero-length ICNS entry instead of looping', () => {
    const { ICNS } = loadCommonJs('dist/types/icns.js');
    const input = Buffer.alloc(24);
    input.write('icns', 0, 'ascii');
    input.writeUInt32BE(24, 4);
    input.write('ic07', 8, 'ascii');
    input.writeUInt32BE(0, 12);

    expect(() => ICNS.calculate(input)).toThrow('Invalid ICNS image entry length');
  });

  test('stops a zero-length JXLP box without looping', () => {
    const realUtils = require(path.join(packageRoot, 'dist/types/utils.js'));
    const findBox = jest
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ name: 'jxlp', offset: 0, size: 0 });
    const { JXL } = loadCommonJs('dist/types/jxl.js', {
      './utils': { ...realUtils, findBox },
    });
    const input = Buffer.alloc(32);
    input.write('JXL ', 4, 'ascii');

    expect(() => JXL.calculate(input)).toThrow();
    expect(findBox).toHaveBeenCalledTimes(2);
  });
});
