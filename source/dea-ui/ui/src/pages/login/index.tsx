/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import { Spinner } from '@cloudscape-design/components';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { getToken } from '../../api/auth';
import { commonLabels } from '../../common/labels';
import { useAuthentication } from '../../context/AuthenticationContext';
import { getCredentialsByToken } from '../../helpers/authService';

export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useAuthentication();

  useEffect(() => {
    const login = async () => {
      const authCode = typeof router.query.code === 'string' ? router.query.code : '';

      if (authCode) {
        const codeVerifier = sessionStorage.getItem('pkceVerifier');
        if (!codeVerifier) {
          signIn();
          return;
        }

        try {
          const response = await getToken(authCode, codeVerifier);
          const username = response.username;
          const credentials = await getCredentialsByToken(
            response.idToken,
            response.identityPoolId,
            response.userPoolId
          );

          localStorage.setItem('username', username);
          sessionStorage.setItem('accessKeyId', credentials.AccessKeyId);
          sessionStorage.setItem('secretAccessKey', credentials.SecretKey);
          sessionStorage.setItem('sessionToken', credentials.SessionToken);
          await router.push('/');
        } catch (e) {
          console.log(e);
          signIn();
          return;
        }
      }
    };

    login().catch((e) => console.log(e));
  }, [router, signIn]);

  return (
    <div>
      <h1>
        {commonLabels.loginLabel}
        <span aria-live="polite" aria-label={commonLabels.loginLabel}>
          <Spinner size="large" />
        </span>
      </h1>
    </div>
  );
}