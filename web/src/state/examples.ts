/** The example clips the build ships under examples/, with the prompts that show them off. Sources: SOURCES.txt there. */
export type Example = {
  readonly title: string;
  readonly file: string;
  readonly prompts: readonly [string, ...string[]];
};

export const EXAMPLES: readonly Example[] = [
  { title: "Produce aisle", file: "produce.mp4", prompts: ["zucchini", "price tag"] },
  { title: "Street drive", file: "street.mp4", prompts: ["car", "street lamp"] },
];

export const exampleUrl = (e: Example) => `examples/${e.file}`;
