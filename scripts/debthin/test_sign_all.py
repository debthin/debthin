import datetime
import os
import tempfile
import unittest
import sign_all

class TestSignAll(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = os.path.join(self.temp_dir.name, "config.json")
        
    def tearDown(self):
        self.temp_dir.cleanup()

    def test_parse_config(self):
        config_content = """{
            "ubuntu": {
                "upstream": "http://archive.ubuntu.com/ubuntu",
                "components": ["main", "universe"],
                "arches": ["amd64", "arm64"],
                "suites": {
                    "noble": {},
                    "noble-updates": {
                        "components": ["main", "universe", "restricted"]
                    }
                }
            },
            "debian": {
                "upstream": "http://deb.debian.org/debian",
                "components": ["main"],
                "suites": {
                    "bookworm": {
                        "arches": ["amd64"]
                    }
                }
            }
        }"""
        with open(self.config_path, "w") as f:
            f.write(config_content)

        jobs = sign_all.parse_config(self.config_path)
        
        # We expect 3 suites from 2 distros
        self.assertEqual(len(jobs), 3)

        # Map to dict for easier assertions
        jobs_dict = {f"{distro}/{suite}": (up, comps, arches) for distro, up, suite, comps, arches in jobs}
        
        self.assertIn("ubuntu/noble", jobs_dict)
        self.assertIn("ubuntu/noble-updates", jobs_dict)
        self.assertIn("debian/bookworm", jobs_dict)
        
        # Check noble overrides (inherits components and arches)
        up, comps, arches = jobs_dict["ubuntu/noble"]
        self.assertEqual(up, "http://archive.ubuntu.com/ubuntu")
        self.assertEqual(comps, "main,universe")
        self.assertEqual(arches, "amd64,arm64")
        
        # Check noble-updates overrides (custom components)
        up, comps, arches = jobs_dict["ubuntu/noble-updates"]
        self.assertEqual(comps, "main,universe,restricted")

    def test_parse_inrelease_data(self):
        content = """Origin: debthin
Label: debthin
Suite: noble
Date: Mon, 30 Mar 2026 12:00:00 UTC
"""
        fields = sign_all.parse_inrelease_data(content)
        self.assertEqual(fields.get("Origin"), "debthin")
        self.assertEqual(fields.get("Suite"), "noble")
        self.assertEqual(fields.get("Date"), "Mon, 30 Mar 2026 12:00:00 UTC")

    def test_format_date(self):
        dt = datetime.datetime(2026, 3, 30, 12, 0, 0, tzinfo=datetime.timezone.utc)
        date_str = sign_all.format_date_rfc2822(dt)
        self.assertEqual(date_str, "Mon, 30 Mar 2026 12:00:00 UTC")

if __name__ == "__main__":
    unittest.main()
