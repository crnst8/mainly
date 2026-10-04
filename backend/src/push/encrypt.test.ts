import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptPayload, isPushEndpoint } from './encrypt.ts';

// RFC 8291 Appendix A, the worked example.
test('encrypts the RFC 8291 example byte for byte', () => {
  const out = encryptPayload(
    Buffer.from('When I grow up, I want to be a watermelon'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    {
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
    },
  );
  assert.equal(
    out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('accepts only https endpoints on known push services', () => {
  assert.equal(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(isPushEndpoint('https://web.push.apple.com/QGx'), true);
  assert.equal(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x'), true);
  assert.equal(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false);
  assert.equal(isPushEndpoint('https://fcm.googleapis.com:8443/x'), false);
  assert.equal(isPushEndpoint('https://evilnotify.windows.com.example/x'), false);
  assert.equal(isPushEndpoint('https://127.0.0.1/x'), false);
  assert.equal(isPushEndpoint('not a url'), false);
});
