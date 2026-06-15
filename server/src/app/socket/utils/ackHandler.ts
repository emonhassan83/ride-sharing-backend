import { TAckFn, TAckRes } from "../interface/index.interface";

const ackHandler = (ack: TAckFn, data: TAckRes) => {
  if (typeof ack === "function") {
    ack(data);
  }
};

export default ackHandler;
