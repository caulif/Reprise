import { parse, parseFragment } from "parse5";

type Node = { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[]; content?: Node };

const htmlTags = new Set([
  "html", "head", "body", "title", "main", "article", "section", "header", "footer",
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i",
  "code", "pre", "blockquote", "br", "hr", "ul", "ol", "li", "table", "caption",
  "thead", "tbody", "tfoot", "tr", "th", "td", "small", "sup", "sub",
]);
const htmlAttrs = new Set(["id", "class", "lang", "dir", "colspan", "rowspan", "scope"]);
const svgTags = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "defs", "lineargradient", "radialgradient", "stop", "clippath",
]);
const svgAttrs = new Set([
  "xmlns", "id", "viewbox", "width", "height", "x", "y", "x1", "x2", "y1", "y2",
  "cx", "cy", "r", "rx", "ry", "d", "points", "transform", "fill", "stroke",
  "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity",
  "fill-opacity", "stroke-opacity", "font-size", "font-family", "text-anchor",
  "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform",
  "clippathunits", "clip-path",
]);

export function unsafeDerivedMarkup(mediaType: string, bytes: Buffer): string | undefined {
  if (mediaType !== "text/html" && mediaType !== "image/svg+xml") return undefined;
  const source = bytes.toString("utf8");
  if (mediaType === "image/svg+xml" && /<\s*[!?]/.test(source)) return "SVG declarations are not allowed.";
  const root = mediaType === "text/html" ? parse(source) as Node : parseFragment(source) as Node;
  if (mediaType === "image/svg+xml") {
    const elements = (root.childNodes ?? []).filter((node) => node.tagName);
    if (elements.length !== 1 || elements[0]?.tagName !== "svg") return "SVG must have one svg root.";
  }
  const tags = mediaType === "text/html" ? htmlTags : svgTags;
  const attrs = mediaType === "text/html" ? htmlAttrs : svgAttrs;
  const visit = (node: Node): string | undefined => {
    if (node.tagName && !tags.has(node.tagName.toLowerCase())) return `Unsafe derived element: ${node.tagName}.`;
    for (const attr of node.attrs ?? []) {
      const name = attr.name.toLowerCase();
      if (!attrs.has(name) || /url\s*\(|[<>]/i.test(attr.value)) return `Unsafe derived attribute: ${name}.`;
    }
    for (const child of node.childNodes ?? []) {
      const error = visit(child);
      if (error) return error;
    }
    if (node.content) return visit(node.content);
    return undefined;
  };
  return visit(root);
}
