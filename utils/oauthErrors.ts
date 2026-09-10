type OAuthErrorShape = {
  code?: string;
  email?: string;
  available_methods?: string[];
  error?: string;
};

function getMethodsLabel(methods: string[] | undefined): string {
  if (!methods || methods.length === 0) return 'your existing sign-in method';
  const labels = methods.map(method => {
    if (method === 'password') return 'email and password';
    if (method === 'google') return 'Google';
    if (method === 'apple') return 'Apple';
    return 'your existing sign-in method';
  });
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

export function getOAuthExistingAccountMessage(
  errorLike: { data?: OAuthErrorShape; message?: string } | null | undefined,
  providerLabel: 'Google' | 'Apple'
): string | null {
  const data = errorLike?.data;
  if (!data || data.code !== 'OAUTH_EXISTING_ACCOUNT_MATCH') return null;
  const email = data.email || 'this email';
  const methodsLabel = getMethodsLabel(data.available_methods);
  return `An account already exists for ${email}. Sign in with ${methodsLabel} first, then connect ${providerLabel} from Settings.`;
}

export function getOAuthLinkErrorMessage(
  errorLike: { data?: OAuthErrorShape; message?: string } | null | undefined,
  providerLabel: 'Google' | 'Apple'
): string | null {
  const data = errorLike?.data;
  if (!data?.code) return null;

  if (data.code === 'OAUTH_EMAIL_MISMATCH') {
    return `${providerLabel} returned ${data.email || 'a different email'}, which does not match this VarsityHub account.`;
  }
  if (data.code === 'OAUTH_PROVIDER_ALREADY_LINKED') {
    return `${providerLabel} is already linked to a different account.`;
  }
  if (data.code === 'APPLE_EMAIL_REQUIRED_FOR_LINK') {
    return 'Apple did not provide an email address for this sign-in.';
  }
  return null;
}
