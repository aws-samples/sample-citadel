export const handler = async (event: { arguments: { input: unknown } }) => {
  return event.arguments.input;
};
