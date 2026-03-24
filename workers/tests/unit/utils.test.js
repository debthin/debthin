import test from 'node:test';
import assert from 'node:assert/strict';
import { isHex64, getContentType, parseURL, tokenizePath } from '../../core/utils.js';
import { inReleaseToRelease } from '../../debthin/utils.js';

test('utils/isHex64', () => {
  assert.equal(isHex64('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), true, 'valid 64 char hex lowercase');
  assert.equal(isHex64('0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'), false, 'uppercase correctly rejected');
  assert.equal(isHex64('a'.repeat(63)), false, 'invalid length 63');
  assert.equal(isHex64('a'.repeat(65)), false, 'invalid length 65');
  assert.equal(isHex64('z'.repeat(64)), false, 'invalid hex char z');
});

test('utils/getContentType', () => {
  assert.equal(getContentType('file.txt'), 'text/plain; charset=utf-8');
  assert.equal(getContentType('file.html'), 'text/html; charset=utf-8');
  assert.equal(getContentType('archive.deb'), 'text/plain; charset=utf-8');
  assert.equal(getContentType('archive.gz'), 'application/x-gzip');
  assert.equal(getContentType('Release'), 'text/plain; charset=utf-8');
  assert.equal(getContentType('InRelease'), 'text/plain; charset=utf-8');
  assert.equal(getContentType('Packages'), 'text/plain; charset=utf-8');
  assert.equal(getContentType('Packages.lz4'), 'application/x-lz4');
  assert.equal(getContentType('unknown.bin'), 'text/plain; charset=utf-8');
});

test('utils/parseURL', () => {
  const req = { url: 'https://example.com/deb/pool/main/a/abc.deb', headers: new Map() };
  const res = parseURL(req);
  assert.equal(res.protocol, 'https');
  assert.equal(res.rawPath, 'deb/pool/main/a/abc.deb');

  const req2 = { url: 'http://foo.bar/', headers: new Map([['x-forwarded-proto', 'http']]) };
  const res2 = parseURL(req2);
  assert.equal(res2.protocol, 'http');
  assert.equal(res2.rawPath, '');
});

test('utils/tokenizePath', () => {
  const tokens = tokenizePath('dists/debian/main/binary-amd64/Packages.gz');
  assert.equal(tokens.p0, 'dists');
  assert.equal(tokens.p1, 'debian');
  assert.equal(tokens.p2, 'main');
  assert.equal(tokens.p3, 'binary-amd64');
  assert.equal(tokens.p4, 'Packages.gz');

  const tokensShort = tokenizePath('dists/ubuntu');
  assert.equal(tokensShort.p0, 'dists');
  assert.equal(tokensShort.p1, 'ubuntu');
  assert.equal(tokensShort.p2, undefined);
});

test('utils/inReleaseToRelease', () => {
  const pgp = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

Origin: Debian
Label: Debian
Suite: stable
Codename: bookworm
Date: Sat, 10 Jun 2023 09:47:33 UTC
Architectures: amd64 arm64 armel armhf i386 mips64el mipsel ppc64el s390x
Components: main contrib non-free non-free-firmware
Description: Debian x.y Released 10 June 2023
-----BEGIN PGP SIGNATURE-----

iQIzBAEBCAAdFiEE...
-----END PGP SIGNATURE-----`;

  const expected = `Origin: Debian
Label: Debian
Suite: stable
Codename: bookworm
Date: Sat, 10 Jun 2023 09:47:33 UTC
Architectures: amd64 arm64 armel armhf i386 mips64el mipsel ppc64el s390x
Components: main contrib non-free non-free-firmware
Description: Debian x.y Released 10 June 2023`;

  assert.equal(inReleaseToRelease(pgp), expected);
});

test('utils/inReleaseToRelease invalid signature fallback', () => {
  const noSig = "Just some text\nHash: SHA256\n";
  assert.equal(inReleaseToRelease(noSig), "Just some text\nHash: SHA256\n");
});
