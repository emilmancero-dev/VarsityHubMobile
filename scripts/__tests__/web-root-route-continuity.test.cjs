const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Route matching is real; only native path-config validation is isolated.
const originalLoad = Module._load;
let getStateFromPath;
try {
  Module._load = function (id) {
    if (id === '@react-navigation/native') return { validatePathConfig() {} };
    return originalLoad.apply(this, arguments);
  };
  ({ getStateFromPath } = require('expo-router/build/fork/getStateFromPath'));
} finally {
  Module._load = originalLoad;
}
const root = path.resolve(__dirname, '../..');
const layout = fs.readFileSync(path.join(root, 'app/(tabs)/_layout.tsx'), 'utf8');
const names = state => {
  const result = [];
  while (state) {
    const route = state.routes[state.index ?? state.routes.length - 1];
    result.push(route.name);
    state = route.state;
  }
  return result;
};

test('root resolution cannot inherit a prior static-render tab group', () => {
  const config = {
    screens: {
      __root: {
        path: '',
        screens: {
          index: '',
          '(tabs)': {
            path: '(tabs)',
            initialRouteName: 'feed/index',
            screens: {
              ...(fs.existsSync(path.join(root, 'app/(tabs)/index.tsx')) ? { index: '' } : {}),
              'feed/index': 'feed',
              'highlights/index': 'highlights',
            },
          },
        },
      },
    },
  };
  for (const previous of [[], ['(tabs)', 'index']]) {
    assert.deepEqual(names(getStateFromPath('/', config, previous)), ['__root', 'index']);
    assert.deepEqual(names(getStateFromPath('/(tabs)', config, previous)), ['__root', '(tabs)']);
    for (const url of ['/feed', '/(tabs)/feed']) {
      assert.deepEqual(names(getStateFromPath(url, config, previous)), [
        '__root',
        '(tabs)',
        'feed/index',
      ]);
    }
  }
});

test('bare tab links initialize Feed independent of screen order', async () => {
  assert.match(layout, /<Tabs\s+initialRouteName="feed\/index"/);
  assert.match(layout, /unstable_settings\s*=\s*\{\s*initialRouteName:\s*'feed\/index'/);
  const { TabRouter } = await import('@react-navigation/routers');
  const router = TabRouter({ initialRouteName: 'feed/index', backBehavior: 'history' });
  const state = router.getInitialState({
    routeNames: ['highlights/index', 'feed/index'],
    routeParamList: {},
    routeGetIdList: {},
  });
  assert.equal(state.routes[state.index].name, 'feed/index');
});
