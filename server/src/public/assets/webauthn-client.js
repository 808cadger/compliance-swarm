// Hand-rolled WebAuthn browser glue — deliberately not @simplewebauthn/browser or any other
// CDN-hosted package: every static page in this repo is self-contained with no build step and
// no third-party script origin (see README's CSP/no-third-party-embed notes for the agent
// pages), and this module is small enough that vendoring the actual library wasn't worth the
// extra surface. It only handles what the two flows in this app need: registering a passkey
// while already signed in, and signing in with one. Field names/shapes here match
// @simplewebauthn/server's *ResponseJSON types exactly (server/src/services/
// identityProviders/PasskeyIdentityProvider.js is the server side of this contract).

function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function browserSupportsWebAuthn() {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && typeof navigator.credentials?.create === 'function';
}

export async function startRegistration(optionsJSON) {
  const publicKey = {
    ...optionsJSON,
    challenge: base64urlToBuffer(optionsJSON.challenge),
    user: { ...optionsJSON.user, id: base64urlToBuffer(optionsJSON.user.id) },
    excludeCredentials: (optionsJSON.excludeCredentials ?? []).map((c) => ({ ...c, id: base64urlToBuffer(c.id) })),
  };

  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) throw new Error('Registration was not completed');

  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      transports: response.getTransports?.() ?? undefined,
    },
  };
}

export async function startAuthentication(optionsJSON) {
  const publicKey = {
    ...optionsJSON,
    challenge: base64urlToBuffer(optionsJSON.challenge),
    allowCredentials: optionsJSON.allowCredentials?.length
      ? optionsJSON.allowCredentials.map((c) => ({ ...c, id: base64urlToBuffer(c.id) }))
      : undefined,
  };

  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new Error('Sign-in was not completed');

  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : undefined,
    },
  };
}
