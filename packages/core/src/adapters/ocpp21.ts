/** OCPP 2.1 adapter: the 2.0.1 adapter on the `ocpp2.1` subprotocol and schemas (see `createOcpp2xAdapter`). */
import { createOcpp2xAdapter } from './ocpp201';
import type { VersionAdapter } from './types';

export const ocpp21: VersionAdapter = createOcpp2xAdapter('ocpp2.1');
