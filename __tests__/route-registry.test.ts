import fs from 'fs';
import path from 'path';

type DeclaredRoute = {
  file: string;
  route: string;
  params: string[];
};

type NavigationCall = {
  file: string;
  kind: string;
  pathname: string;
  paramKeys: string[];
};

const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, 'app');
const SOURCE_DIRS = ['app', 'components', 'hooks', 'context', 'utils', 'api'];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(next);
    return [next];
  });
}

function isRoutableAppFile(file: string): boolean {
  const rel = path.relative(APP_DIR, file).replace(/\\/g, '/');
  if (!/\.(ts|tsx)$/.test(rel)) return false;
  if (/\.test\.(ts|tsx)$/.test(rel)) return false;
  if (/\/__tests__\//.test(rel)) return false;

  const base = path.basename(rel);
  if (base.startsWith('_')) return false;
  if (base.startsWith('+')) return false;
  return true;
}

function normalizeRouteLike(value: string): string {
  const [pathname] = value.replace(/\\/g, '/').split(/[?#]/, 1);
  const stripped = pathname
    .split('/')
    .filter(Boolean)
    .filter(segment => !/^\(.*\)$/.test(segment))
    .join('/');

  return stripped ? `/${stripped}` : '/';
}

function fileToRoute(file: string): DeclaredRoute {
  let rel = path.relative(APP_DIR, file).replace(/\\/g, '/');
  rel = rel.replace(/\.web\.(ts|tsx)$/, '');
  rel = rel.replace(/\.(ts|tsx)$/, '');
  if (rel === 'index') rel = '';
  if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);

  const route = normalizeRouteLike(rel);
  const params = Array.from(route.matchAll(/\[([^\]]+)\]/g)).map(match =>
    match[1].replace('...', '')
  );

  return { file, route, params };
}

function routeToRegex(route: string): RegExp {
  const pattern = route
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\[\.{3}([^\]]+)\\\]/g, '.+')
    .replace(/\\\[([^\]]+)\\\]/g, '[^/]+');

  return new RegExp(`^${pattern}$`);
}

function extractParamKeys(paramsBlock?: string): string[] {
  if (!paramsBlock) return [];

  return Array.from(paramsBlock.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)).map(match => match[1]);
}

function extractNavigationCalls(file: string): NavigationCall[] {
  const source = fs.readFileSync(file, 'utf8');
  const calls: NavigationCall[] = [];

  const stringRouterCall = /router\.(push|replace|navigate)\(\s*(['"`])([^'"`]+)\2/g;

  for (const match of source.matchAll(stringRouterCall)) {
    const pathname = match[3];
    if (!pathname.startsWith('/')) continue;
    if (pathname.includes('${')) continue;
    calls.push({
      file,
      kind: `router.${match[1]}`,
      pathname,
      paramKeys: [],
    });
  }

  const objectRouterCall =
    /router\.(push|replace|navigate)\(\s*\{\s*pathname:\s*(['"`])([^'"`]+)\1\s*,\s*params:\s*\{([\s\S]*?)\}\s*\}/g;

  for (const match of source.matchAll(objectRouterCall)) {
    const pathname = match[2];
    if (!pathname.startsWith('/')) continue;
    calls.push({
      file,
      kind: `router.${match[1]}`,
      pathname,
      paramKeys: extractParamKeys(match[3]),
    });
  }

  const stringHref = /<(Link|Redirect)\b[^>]*\shref=\s*(['"`])([^'"`]+)\2/g;

  for (const match of source.matchAll(stringHref)) {
    const pathname = match[3];
    if (!pathname.startsWith('/')) continue;
    if (pathname.includes('${')) continue;
    calls.push({
      file,
      kind: match[1],
      pathname,
      paramKeys: [],
    });
  }

  const objectHref =
    /<(Link|Redirect)\b[^>]*\shref=\s*\{\s*\{\s*pathname:\s*(['"`])([^'"`]+)\2\s*,\s*params:\s*\{([\s\S]*?)\}\s*\}\s*\}/g;

  for (const match of source.matchAll(objectHref)) {
    const pathname = match[3];
    if (!pathname.startsWith('/')) continue;
    calls.push({
      file,
      kind: match[1],
      pathname,
      paramKeys: extractParamKeys(match[4]),
    });
  }

  return calls;
}

function resolveDeclaredRoute(
  pathname: string,
  declaredRoutes: DeclaredRoute[]
): DeclaredRoute | undefined {
  const normalized = normalizeRouteLike(pathname);

  return declaredRoutes.find(declared => {
    if (declared.route === normalized) return true;
    return routeToRegex(declared.route).test(normalized);
  });
}

describe('route registry', () => {
  it('maps the root index to / just like nested index routes', () => {
    expect(fileToRoute(path.join(APP_DIR, 'index.tsx')).route).toBe('/');
  });
  const declaredRoutes = walk(APP_DIR).filter(isRoutableAppFile).map(fileToRoute);

  const navigationCalls = SOURCE_DIRS.flatMap(dir => walk(path.join(ROOT, dir)))
    .filter(file => /\.(ts|tsx)$/.test(file))
    .filter(file => !/\.test\.(ts|tsx)$/.test(file))
    .filter(file => !/\/__tests__\//.test(file))
    .flatMap(extractNavigationCalls);

  it('every statically analyzable navigation target resolves to a declared route', () => {
    const unresolved = navigationCalls
      .filter(call => !resolveDeclaredRoute(call.pathname, declaredRoutes))
      .map(call => ({
        file: path.relative(ROOT, call.file),
        kind: call.kind,
        pathname: call.pathname,
      }));

    expect(unresolved).toEqual([]);
  });

  it('every object-style dynamic route call supplies required path params', () => {
    const missingParams = navigationCalls
      .map(call => {
        const declared = resolveDeclaredRoute(call.pathname, declaredRoutes);
        if (!declared) return null;

        const dynamicParams = Array.from(
          normalizeRouteLike(call.pathname).matchAll(/\[([^\]]+)\]/g)
        ).map(match => match[1].replace('...', ''));

        if (dynamicParams.length === 0) return null;

        const missing = dynamicParams.filter(param => !call.paramKeys.includes(param));

        if (missing.length === 0) return null;

        return {
          file: path.relative(ROOT, call.file),
          kind: call.kind,
          pathname: call.pathname,
          missing,
        };
      })
      .filter(Boolean);

    expect(missingParams).toEqual([]);
  });
});
