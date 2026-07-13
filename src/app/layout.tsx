import type { Metadata } from "next";
import Link from "next/link";
import { currentSeoRuntime } from "@/lib/seo";
import "./globals.css";

export function generateMetadata(): Metadata {
  const runtime = currentSeoRuntime();
  return {
    title: {
      default: "RepairPrint Index",
      template: "%s · RepairPrint Index",
    },
    description: "Find evidence-backed 3D-printable replacement parts for the exact product you own.",
    ...(runtime.origin ? { metadataBase: new URL(runtime.origin) } : {}),
    robots: runtime.indexingAllowed
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true, noarchive: true },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to main content</a>
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
        <main id="main-content" tabIndex={-1}>{children}</main>
        <footer className="site-footer">
          <div className="shell footer-grid">
            <div>
              <div className="brand footer-brand"><span className="brand-mark" aria-hidden="true">R</span><span>RepairPrint Index</span></div>
              <p>Fitment evidence and attribution first. Original files stay with their creators.</p>
              <p><Link href="/independence">Independent; not manufacturer-endorsed.</Link></p>
            </div>
            <nav aria-labelledby="footer-contribute-heading">
              <h2 id="footer-contribute-heading">Contribute</h2>
              <Link href="/confirm-fit">Report a fit</Link>
              <Link href="/request-part">Request a missing part</Link>
              <Link href="/submit-design">Submit a source link</Link>
              <Link href="/contribution-privacy">Contribution privacy</Link>
            </nav>
            <nav aria-labelledby="footer-trust-heading">
              <h2 id="footer-trust-heading">Trust</h2>
              <Link href="/methodology">Methodology</Link>
              <Link href="/safety">Safety policy</Link>
              <Link href="/licensing">Licensing and attribution</Link>
              <Link href="/privacy">General privacy</Link>
              <Link href="/corrections">Corrections</Link>
              <Link href="/notice">Notices and urgent safety</Link>
              <Link href="/independence">Independence</Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
