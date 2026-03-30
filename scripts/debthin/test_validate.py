import os
import tempfile
import unittest
import validate

class TestValidate(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.inrelease_path = os.path.join(self.temp_dir.name, "InRelease")
        
    def tearDown(self):
        self.temp_dir.cleanup()

    def test_parse_inrelease(self):
        content = """-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Origin: DebThin
Label: DebThin Default
Suite: noble
Codename: noble
Date: Mon, 30 Mar 2026 12:00:00 UTC
Architectures: amd64 arm64
Components: main universe
Description: Dummy repository InRelease file

SHA256:
 073a9eb6cfec157a8a184e917d0bb2be7839db080b0edfac7e6e2f139fb2bca2 2147 main/binary-amd64/Packages.gz
 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 1024 universe/binary-amd64/Packages.gz
 7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069 50 main/i18n/Translation-en
-----BEGIN PGP SIGNATURE-----
"""
        with open(self.inrelease_path, "w") as f:
            f.write(content)

        fields = validate.parse_inrelease(self.inrelease_path)
        self.assertEqual(fields.get("Origin"), "DebThin")
        self.assertEqual(fields.get("Suite"), "noble")
        self.assertEqual(fields.get("Components"), "main universe")

    def test_parse_inrelease_hashes(self):
        content = """-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Origin: DebThin

SHA256:
 073a9eb6cfec157a8a184e917d0bb2be7839db080b0edfac7e6e2f139fb2bca2 2147 main/binary-amd64/Packages.gz
 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 1024 universe/binary-amd64/Packages.gz
 7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069 50 main/i18n/Translation-en
-----BEGIN PGP SIGNATURE-----
"""
        with open(self.inrelease_path, "w") as f:
            f.write(content)

        hashes = validate.parse_inrelease_hashes(self.inrelease_path)
        self.assertEqual(len(hashes), 3)
        self.assertEqual(hashes[0], ("073a9eb6cfec157a8a184e917d0bb2be7839db080b0edfac7e6e2f139fb2bca2", 2147, "main/binary-amd64/Packages.gz"))
        self.assertEqual(hashes[2], ("7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069", 50, "main/i18n/Translation-en"))

if __name__ == "__main__":
    unittest.main()
