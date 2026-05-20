// import awsLogo from "figma:asset/a88a53af75ff717ec66019e9b2e746a31f4e00d8.png";
const imageUrl = new URL('/public/aws_logo.png', import.meta.url).href

interface AwsBannerProps {
  title?: string;
  description?: string;
  variant?: "default" | "compact";
}

export function AwsBanner({
  title = " Citadel",
  description = "Enterprise-grade platform for building, deploying, and managing intelligent AI agentic systems at scale",
  variant = "default",
}: AwsBannerProps = {}) {
  // SVG pattern for background grid
  const gridPattern =
    "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAxMCAwIEwgMCAwIDAgMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0icmdiYSgyNTUsMjU1LDI1NSwwLjAzKSIgc3Ryb2tlLXdpZHRoPSIxIi8+PC9wYXR0ZXJuPjwvZGVmcz48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2dyaWQpIi8+PC9zdmc+";

  const isCompact = variant === "compact";

  return (
    <div
      className="relative overflow-hidden rounded-lg"
      style={{
        /* brand-gradient: documented exception per UI-shadcn-FIX.md */
        background: "linear-gradient(to right, rgba(234, 88, 12, 0.3), rgba(249, 115, 22, 0.2), rgba(251, 146, 60, 0.15), rgba(37, 99, 235, 0.25))",
        border: "1px solid rgba(249, 115, 22, 0.5)",
      }}
    >
      {/* Background grid pattern */}
      <div
        className="absolute inset-0 opacity-50"
        style={{ backgroundImage: `url('${gridPattern}')` }}
      />

      {/* Content */}
      <div
        className={`relative flex flex-col items-center justify-center text-center ${isCompact ? "px-4 py-4" : "px-6 py-8"}`}
      >
        <div
          className={`flex items-center gap-3 ${isCompact ? "mb-1" : "mb-2"}`}
        >
          <img
            src={imageUrl}
            alt="AWS"
            width={60}
            className={`object-contain ${isCompact ? "h-8" : "h-12"} w-auto`}
          /> 

          <h2 className={`font-bold ${isCompact ? "text-2xl" : "text-5xl"}`}>
            <span
              className="inline-block bg-clip-text text-transparent"
              style={{
                /* brand-gradient: documented exception per UI-shadcn-FIX.md */
                backgroundImage: "linear-gradient(90deg, #FFA500 0%, #FF8C00 25%, #FF6B00 50%, #FF4500 75%, #DC143C 100%)",
              }}
            >
              {title}
            </span>
          </h2>
        </div>
        <p
          className={`text-muted-foreground max-w-2xl ${isCompact ? "text-xs" : "text-sm"}`}
        >
          {description}
        </p>
      </div>
    </div>
  );
}