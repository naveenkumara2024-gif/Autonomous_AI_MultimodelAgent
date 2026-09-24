// PowerShell worker scripts are imported as text (Bun's `with { type: "text" }`),
// so they live as real .ps1 files instead of template strings inside TS.
declare module "*.ps1" {
  const content: string;
  export default content;
}
