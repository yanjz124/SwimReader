// Shim for OpenTK.MathHelper — only the members DGScope uses.
export const MathHelper = {
    DegreesToRadians(deg) { return deg * (Math.PI / 180); },
    RadiansToDegrees(rad) { return rad * (180 / Math.PI); },
    Pi: Math.PI,
    TwoPi: Math.PI * 2,
};
