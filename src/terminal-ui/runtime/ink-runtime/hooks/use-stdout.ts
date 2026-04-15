type UseStdoutResult = {
  stdout: NodeJS.WriteStream;
};

const stdoutValue: UseStdoutResult = {
  stdout: process.stdout
};

const useStdout = (): UseStdoutResult => {
  return stdoutValue;
};

export default useStdout;
