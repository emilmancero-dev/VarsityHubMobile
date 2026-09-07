const forge = require('node-forge');

describe('patched node-forge RSA verification', () => {
  test('rejects an extra DigestAlgorithm child', () => {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 3 });
    const digest = forge.md.sha256.create().update('varsityhub').digest().getBytes();
    const digestAlgorithm = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer(forge.oids.sha256).getBytes()
        ),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
      ]
    );
    const digestInfo = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        digestAlgorithm,
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, digest),
      ]
    );
    const signature = keys.privateKey.sign(forge.asn1.toDer(digestInfo).getBytes(), 'NONE');

    expect(() => keys.publicKey.verify(digest, signature)).toThrow(
      'ASN.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value'
    );
  });
});
