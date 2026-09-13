import { toUserMessage } from '@/utils/toUserMessage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
// @ts-ignore
import { User } from '@/api/entities';
import { VerificationCodeScreenBase } from '@/components/VerificationCodeScreenBase';
import { useAuth } from '@/context/AuthProvider';
import { useVerificationGate } from '@/hooks/useVerificationGate';
import { useVerificationScreenActions } from '@/hooks/useVerificationScreenActions';
import { getFreshAuthSnapshot } from '@/utils/authState';
import { safeGoBack } from '@/utils/navigation';
import { getPostAuthLandingRoute } from '@/utils/postAuthRouting';

type ParamValue = string | string[] | undefined;

const toSingleValue = (value: ParamValue): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

function VerifyScreen() {
  const router = useRouter();
  const { user, checkAuth } = useAuth();
  const params = useLocalSearchParams<{ devCode?: ParamValue }>();

  const [screenInfo, setScreenInfo] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setScreenError(null);
    setScreenInfo(null);
    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    };
  }, []);

  const gate = useVerificationGate({
    requestCode: () => User.requestVerification(),
    confirmCode: (code: string) => User.verifyEmail(code),
    autoFinishOnVerified: false,
    resendCooldownSeconds: 60,
    getRequestSuccessState: (res: any) => ({
      info:
        __DEV__ && res?.dev_verification_code
          ? `Code sent (dev: ${res.dev_verification_code})`
          : 'Code sent',
      cooldownSeconds: 60,
    }),
    getConfirmErrorMessage: (e: any) => toUserMessage(e, 'Verification failed'),
    getRequestErrorMessage: (e: any) => toUserMessage(e, 'Resend failed'),
    onVerified: async () => {
      const freshUser = (await getFreshAuthSnapshot(checkAuth, user)) as any;
      setScreenInfo('Email verified successfully!');
      setScreenError(null);
      setIsVerified(true);

      try {
        const userInfo = freshUser ?? user;
        if (!userInfo) {
          throw new Error('missing_user');
        }
        const targetRoute = getPostAuthLandingRoute(userInfo);
        redirectTimerRef.current = setTimeout(() => {
          router.replace(targetRoute as any);
        }, 3000);
      } catch (meErr: any) {
        const status = meErr?.status ?? meErr?.response?.status ?? null;
        if (status === 401 || status === 403) {
          setScreenError('Your session expired. Please sign in again.');
          redirectTimerRef.current = setTimeout(() => router.replace('/sign-in'), 2000);
        } else {
          setScreenError('Could not load your profile. Tap Continue to retry.');
        }
      }
    },
  });
  const setGateCode = gate.setCode;
  // Never use devCode in production — it would allow bypassing verification via URL param
  const devCodeParam = __DEV__ ? toSingleValue(params.devCode) : undefined;
  const clearMessages = () => {
    setScreenError(null);
    setScreenInfo(null);
  };

  const { onVerify, onResend } = useVerificationScreenActions({
    devCodeParam,
    setGateCode,
    setDevCode,
    clearMessages,
    verify: gate.verify,
    resend: gate.resend,
  });

  const onContinue = async () => {
    try {
      const userInfo = ((await getFreshAuthSnapshot(checkAuth, user)) ?? user) as any;
      if (!userInfo) {
        throw new Error('missing_user');
      }
      router.replace(getPostAuthLandingRoute(userInfo) as any);
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status ?? null;
      if (status === 401 || status === 403) {
        setScreenError('Your session expired. Please sign in again.');
        router.replace('/sign-in');
      } else {
        setScreenError('Could not load your profile. Please try again.');
      }
    }
  };

  return (
    <VerificationCodeScreenBase
      subtitle="We sent a 6-digit verification code to your email address."
      gate={gate}
      screenError={screenError}
      screenInfo={screenInfo}
      isVerified={isVerified}
      onVerify={onVerify}
      onResend={onResend}
      onContinue={onContinue}
      useKeyboardAwareScroll
      showBackButton
      onBackPress={() => {
        safeGoBack(router);
      }}
      devCode={devCode}
      backLinkLabel="Go back"
      onBackLinkPress={() => {
        safeGoBack(router);
      }}
      verifiedHintText="Automatically continuing in a few seconds..."
    />
  );
}

export default VerifyScreen;
