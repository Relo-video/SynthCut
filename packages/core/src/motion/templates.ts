/**
 * Built-in motion-graphic templates, authored as Remotion components and stored
 * as TSX source strings. These are exactly the same kind of component the AI
 * authors via `add_graphic` (the authoring API accepts arbitrary TSX) — the
 * desktop UI and the smoke test use the built-in title card so there is always
 * a known-good component to render.
 *
 * The contract for any graphic component:
 *   - default-export a React component
 *   - it may use Remotion hooks/helpers: useCurrentFrame, useVideoConfig,
 *     interpolate, spring, AbsoluteFill, Sequence, etc. (from "remotion")
 *   - it receives the `props` object passed to add_graphic
 *   - for an OVERLAY, leave the background transparent (don't fill the frame);
 *     for a STANDALONE card, accept a `background` prop and fill it.
 */

export interface TitleCardProps {
  title?: string;
  subtitle?: string;
  /** Text color (CSS). Default "white". */
  color?: string;
  /** Accent bar color (CSS). Default "#4ea1ff". */
  accent?: string;
  /** Background CSS color for a standalone card; null/omitted = transparent overlay. */
  background?: string | null;
}

/**
 * Animated title card: a centered title + optional subtitle with a spring
 * entrance, a growing accent underline, and a gentle fade in/out. Renders on a
 * transparent background by default so it can be composited over footage.
 */
export const TITLE_CARD_TSX = String.raw`import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";

type Props = {
  title?: string;
  subtitle?: string;
  color?: string;
  accent?: string;
  background?: string | null;
};

const TitleCard: React.FC<Props> = ({
  title = "Title",
  subtitle = "",
  color = "white",
  accent = "#4ea1ff",
  background = null,
}) => {
  const frame = useCurrentFrame();
  const { fps, height, width, durationInFrames } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.6 } });
  const translateY = interpolate(enter, [0, 1], [42, 0]);
  const fade = interpolate(
    frame,
    [0, 10, durationInFrames - 14, durationInFrames - 1],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const barWidth = interpolate(enter, [0, 1], [0, Math.min(width * 0.45, 520)]);

  return (
    <AbsoluteFill
      style={{
        background: background ?? "transparent",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      <div
        style={{
          opacity: fade,
          transform: "translateY(" + translateY + "px)",
          textAlign: "center",
          padding: "0 6%",
        }}
      >
        <div
          style={{
            fontSize: Math.round(height * 0.09),
            fontWeight: 800,
            color,
            letterSpacing: 1,
            lineHeight: 1.05,
            textShadow: "0 6px 30px rgba(0,0,0,0.55)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            height: 6,
            width: barWidth,
            background: accent,
            margin: "26px auto",
            borderRadius: 3,
            boxShadow: "0 0 18px " + accent,
          }}
        />
        {subtitle ? (
          <div
            style={{
              fontSize: Math.round(height * 0.04),
              color,
              opacity: 0.88,
              textShadow: "0 3px 18px rgba(0,0,0,0.5)",
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

export default TitleCard;
`;

/** Named built-in templates the AI/UI can request without authoring TSX. */
export const GRAPHIC_TEMPLATES = {
  title: TITLE_CARD_TSX,
} as const;

export type GraphicTemplate = keyof typeof GRAPHIC_TEMPLATES;
export const GRAPHIC_TEMPLATE_NAMES = Object.keys(GRAPHIC_TEMPLATES) as [GraphicTemplate, ...GraphicTemplate[]];
