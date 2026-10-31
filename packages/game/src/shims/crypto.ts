// ponytail: OCMF signing is off in the game and the PKI is never loaded; these only satisfy the imports.
import { noop } from './noop';

export const createPrivateKey = noop;
export const createPublicKey = noop;
export const generateKeyPairSync = noop;
export const sign = noop;
export const createHash = noop;
