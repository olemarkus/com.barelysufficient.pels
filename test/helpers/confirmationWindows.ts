import { WriteAnswerTimes } from '../../lib/device/transport/writeAnswerTimes';
import {
  CONTROL_COMMAND_CONFIRMATION_MS,
  type ConfirmationWindows,
} from '../../lib/ports/controlCommandConfirmation';

/** Every device on the fixed window, as an unlearned device runs in production. */
export const fixedConfirmationWindows: ConfirmationWindows = {
  windowMs: () => CONTROL_COMMAND_CONFIRMATION_MS,
  unconfirmed: () => undefined,
};

/** A fresh transport learner, live feed up, nothing learned yet. */
export const newWriteAnswerTimes = (): WriteAnswerTimes => new WriteAnswerTimes(Date.now(), () => true);
