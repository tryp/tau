declare module "ms" {
  type StringValue = string;
  interface Options {
    long?: boolean;
  }
  function ms(value: StringValue, options?: Options): number;
  function ms(value: number, options?: Options): string;
  export default ms;
}
