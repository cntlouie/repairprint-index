import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "RepairPrint Index",
    template: "%s · RepairPrint Index",
  },
  description: "Find evidence-backed 3D-printable replacement parts for the exact product you own.",
  robots:
    process.env.DEMO_MODE !== "false"
      ? { index: false, follow: false, nocache: true }
      : undefined,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="shell header-inner">
            <Link className="brand" href="/" aria-label="RepairPrint Index home">
              <span className="brand-mark" aria-hidden="true">R</span>
              <span>RepairPrint <strong>Index</strong></span>
            </Link>
            <nav aria-label="Primary navigation">
              <Link href="/search">Search</Link>
              <Link href="/request-part">Request a part</Link>
              <Link href="/submit-design">Submit a design</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="shell footer-grid">
            <div>
              <div className="brand footer-brand"><span className="brand-mark">R</span><span>RepairPrint Index</span></div>
              <p>Fitment evidence and attribution first. Original files stay with their creators.</p>
            </div>
            <div>
              <h2>Contribute</h2>
              <Link href="/confirm-fit">Report a fit</Link>
              <Link href="/request-part">Request a missing part</Link>
              <Link href="/submit-design">Submit a source link</Link>
            </div>
            <div>
              <h2>Trust</h2>
              <Link href="/methodology">Methodology</Link>
              <Link href="/safety">Safety policy</Link>
              <Link href="/licensing">Licensing and takedown</Link>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
