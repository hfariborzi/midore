import { ImageResponse } from "next/og";
import QRCode from "qrcode";
import { MARK_BODY, MARK_COLOR, MARK_TOP, MARK_VIEWBOX } from "@/components/Logo";

export function bookingQrImage(url: string, title: string, slug: string) {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: "M" });
  // Four blank modules on every side keep the artwork outside the scanner's quiet zone.
  const gridSize = modules.size + 8;
  const pixels = gridSize * Math.floor(480 / gridSize);
  let path = "";
  for (let row = 0; row < modules.size; row++) {
    for (let column = 0; column < modules.size; column++) {
      if (modules.get(row, column)) path += `M${column + 4} ${row + 4}h1v1h-1z`;
    }
  }
  const titleChars = Array.from(title);
  const displayTitle = titleChars.length > 70 ? `${titleChars.slice(0, 69).join("")}…` : title;

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", padding: 24, background: MARK_COLOR, color: "#171717" }}>
        <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", background: "white", borderRadius: 30 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 52, fontWeight: 700, letterSpacing: -2 }}>
            <svg width="34" height="47" viewBox={MARK_VIEWBOX} fill={MARK_COLOR}>
              <path d={MARK_TOP} />
              <path d={MARK_BODY} />
            </svg>
            <span>midore</span>
          </div>
          <svg width={pixels} height={pixels} viewBox={`0 0 ${gridSize} ${gridSize}`}>
            <path fill="#171717" d={path} />
          </svg>
          <div style={{ display: "flex", maxWidth: 600, textAlign: "center", fontSize: 33, fontWeight: 700, lineHeight: 1.2 }}>
            {displayTitle}
          </div>
          <div style={{ display: "flex", marginTop: 14, fontSize: 24, color: "#525252" }}>Scan to book</div>
        </div>
      </div>
    ),
    {
      width: 760,
      height: 820,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="midore-${encodeURIComponent(slug)}-qr.png"`,
      },
    },
  );
}
