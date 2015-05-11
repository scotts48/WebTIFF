/*
 * TypeScript TIFF Libary
 * Copyright 2015 NBT, Inc.
 * Released under the MIT license. See LICENSE.txt for details.
 */
var NBT;
(function (NBT) {
    "use strict";
    /* tslint:disable:no-bitwise */
    /* tslint:disable:comment-format:check-space */
    /* tslint:disable:comment-format:check-lowercase */
    /* tslint:disable:no-trailing-whitespace */
    var BitReader = (function () {
        function BitReader(bits, msb2lsb) {
            this.bits = null;
            this.msb2lsb = true;
            this.byteOffset = 0;
            this.bitOffset = 8; //force read of first byte
            this.curByte = 0;
            this.bits = bits;
            this.msb2lsb = msb2lsb;
        }
        BitReader.prototype.readNextByte = function () {
            if (this.byteOffset >= this.bits.byteLength) {
                throw "Unexpected end of data!";
            }
            this.curByte = this.bits.getUint8(this.byteOffset);
            this.byteOffset++;
            this.bitOffset = 0;
        };
        BitReader.prototype.readNextBit = function () {
            if (this.bitOffset > 7) {
                this.readNextByte();
            }
            var nextBit = 0;
            if (this.msb2lsb) {
                nextBit = (this.curByte & (0x80 >> this.bitOffset)) >> (7 - this.bitOffset);
            }
            else {
                nextBit = (this.curByte & (0x1 << this.bitOffset)) >> (this.bitOffset);
            }
            this.bitOffset++;
            return nextBit;
        };
        return BitReader;
    })();
    var G3G4Decoder = (function () {
        function G3G4Decoder() {
            this.fillOrder = G3G4Helper.fillOrder_MSBtoLSB;
            this.whiteIsZero = true;
            this.setWhitePixels = true;
            this.setBlackPixels = true;
            this.bitReader = null; // input for decoding
            this.pixels = null; // output for the pixels
            // these contain the positions of changing elemenets on the current and reference line.
            // after a line is completed, the curRun is moved to the refRun.
            this.refRun = null;
            this.curRun = null;
            // these are the position in the above arrays to write/read the next changing element
            this.refRunIndex = 0;
            this.curRunIndex = 0;
            this.vPos = 0; // the current line number we're on starting with line 0
            this.a0 = 0; // current position on (de)coding line
            // a1: number = 0;   	// next changing element to the right of a0
            // a2: number = 0;   	// next changing element to the right of a1
            this.b1 = 0; // change element on the reference line > a0 and opposite color
            // b2: number = 0;		// next changing element on the reference line > b1
            this.passLength = 0; // length of one or pass codes to add to the current run length
            this.isWhite = true; // are we currently on a white or black run
        }
        G3G4Decoder.prototype.reset = function () {
            this.bitReader = null;
            this.pixels = null;
            this.rowOffset = 0;
            this.refRun = null;
            this.curRun = null;
            this.refRunIndex = 0;
            this.curRunIndex = 0;
            this.vPos = 0;
            this.a0 = 0;
            // a1 = 0;
            // a2 = 0;
            this.b1 = 0;
            // b2 = 0;
            this.passLength = 0;
            this.isWhite = true;
        };
        G3G4Decoder.prototype.decodeG4 = function (bits, pixels, rowOffset) {
            // prepare for new decoding operation
            this.reset();
            this.bitReader = new BitReader(bits, this.fillOrder === G3G4Helper.fillOrder_MSBtoLSB);
            this.pixels = pixels;
            this.rowOffset = rowOffset;
            // the reason we do imageWidth+1 is due to how the UpdateRefChangePOS works
            this.refRun = new Array(this.imageWidth + 1);
            this.curRun = new Array(this.imageWidth + 1);
            // in the beginning...we have a complete white line
            this.curRun[0] = this.imageWidth;
            this.curRunIndex = 1;
            // this will swap the current we just made to be the reference line
            this.prepareForNextLine();
            var eolCounter = 0;
            // the main decoding loop.  We look for one of several codes which
            // tell us how to interpret the data that follows.
            var exitLoop = false;
            while (!exitLoop && this.vPos < this.imageHeight) {
                var code = this.readModeCode();
                if (code !== G3G4Helper.mode_EOL) {
                    eolCounter = 0;
                }
                switch (code) {
                    case G3G4Helper.mode_Unknown:
                        throw "Unknown mode code was encountered!";
                    case G3G4Helper.mode_Pass:
                        {
                            // we are supposed to "PASS" over the other color util we get the
                            // next changing element of our original color
                            //
                            // |   XXXXX  |
                            // |          |
                            //          ^we end up here.
                            this.b1 = this.getNextRefChangePos(this.a0, this.isWhite);
                            this.b1 = this.getNextRefChangePos(this.b1, !this.isWhite);
                            // we store the number of pixels we "PASS" and add
                            // it to the runLength in DecodeRun.
                            this.passLength += (this.b1 - this.a0);
                            // always update a0 to be the correct decoding position
                            this.a0 += (this.b1 - this.a0);
                            break;
                        }
                    case G3G4Helper.mode_Horz:
                        // this tells us to read and decode ONE SET of white and black pixels (Make-Up/Term Codes)
                        this.readHorzRun();
                        this.readHorzRun();
                        break;
                    case G3G4Helper.mode_Vert0:
                        // we copy the refence line exactly until the next
                        // changing element on the reference line
                        this.b1 = this.getNextRefChangePos(this.a0, this.isWhite);
                        this.decodeRun(this.b1 - this.a0);
                        break;
                    case G3G4Helper.mode_VertR1:
                        // we copy the refence line exactly until the next
                        // changing element on the reference line, then add
                        // one more pixel(s) of our current color
                        this.b1 = this.getNextRefChangePos(this.a0, this.isWhite);
                        this.decodeRun((this.b1 - this.a0) + 1);
                        break;
                    case G3G4Helper.mode_VertR2:
                        // we copy the refence line exactly until the next
                        // changing element on the reference line, then add
                        // two more pixel(s) of our current color
                        this.b1 = this.getNextRefChangePos(this.a0, this.isWhite);
                        this.decodeRun((this.b1 - this.a0) + 2);
                        break;
                    case G3G4Helper.mode_VertR3:
                        // we copy the refence line exactly until the next
                        // changing element on the reference line, then add
                        // three more pixel(s) of our current color
                        this.b1 = this.getNextRefChangePos(this.a0, this.isWhite);
                        this.decodeRun((this.b1 - this.a0) + 3);
                        break;
                    case G3G4Helper.mode_VertL1:
                        // we copy the refence line exactly until one pixel(s)
                        // before the next changing element on the reference line
                        this.b1 = this.getNextRefChangePos(this.a0, this.isWhite);
                        this.decodeRun((this.b1 - this.a0) - 1);
                        break;
                    case G3G4Helper.mode_VertL2:
                        // we copy the refence line exactly until two pixel(s)
                        // before the next changing element on the reference line
                        this.b1 = this.getNextRefChangePos(this.a0, this.isWhite);
                        this.decodeRun((this.b1 - this.a0) - 2);
                        break;
                    case G3G4Helper.mode_VertL3:
                        // we copy the refence line exactly until three pixel(s)
                        // before the next changing element on the reference line
                        this.b1 = this.getNextRefChangePos(this.a0, this.isWhite);
                        this.decodeRun((this.b1 - this.a0) - 3);
                        break;
                    case G3G4Helper.mode_Ext1D:
                        throw "Ext1D codes not supported";
                    case G3G4Helper.mode_Ext2D:
                        throw "Ext2D codes not supported";
                    case G3G4Helper.mode_EOL:
                        // two end of line codes indicates the end of the image
                        eolCounter++;
                        // force the loop to exit whether we
                        // have more data or not...
                        if (eolCounter >= 2) {
                            exitLoop = true;
                        }
                        break;
                }
                // we are done decoding a line!!
                if (this.a0 >= this.imageWidth) {
                    this.completeLine();
                }
            }
            // return the actual decoded height of the image
            this.imageHeight = this.vPos;
        };
        G3G4Decoder.prototype.readModeCode = function () {
            var findCodeBitCount = 0;
            var findCodeValue = 0;
            while (true) {
                // shift everything over to make room for the next bit
                findCodeValue = (findCodeValue << 1) | this.bitReader.readNextBit();
                findCodeBitCount++;
                // the number of bits we've read and the value of those bits is combined into
                // an index into the Mode Code array
                var mode = G3G4Helper.lookupMode(findCodeBitCount, findCodeValue);
                if (mode) {
                    return mode;
                }
            }
        };
        G3G4Decoder.prototype.readHorzRun = function () {
            var runLength = 0;
            var findCodeBitCount = 0;
            var findCodeValue = 0;
            while (true) {
                // shift everything over to make room for the next bit
                findCodeValue = (findCodeValue << 1) | this.bitReader.readNextBit();
                findCodeBitCount++;
                // the number of bits we've read and the value of those bits is combined into
                // an index into the Make-Up Code array
                var entry = G3G4Helper.lookupDecode(this.isWhite, findCodeBitCount, findCodeValue);
                if (entry) {
                    // add to our run length and move on...
                    runLength += entry.crl;
                    // get read for next code...
                    findCodeValue = 0;
                    findCodeBitCount = 0;
                    // we're done when we hit a terminate code
                    if (entry.ct === G3G4Helper.code_Terminate) {
                        break;
                    }
                }
            }
            // we're done accumulating pixels for this color, go ahead
            // and add it to the line...
            this.decodeRun(runLength);
        };
        G3G4Decoder.prototype.getNextRefChangePos = function (curPos, curPosIsWhite) {
            ///////////////////////
            // -> REFERENCE CODE //
            ///////////////////////
            //if (curPos == 0) {
            //    return curPosIsWhite ? this.refRun[0] : this.refRun[1];
            //}
            //this.refRunIndex = curPosIsWhite ? 0 : 1;
            //var newChangePos = 0;
            //for (; this.refRunIndex < this.refRun.length; this.refRunIndex += 2) {
            //    if (this.refRun[this.refRunIndex] === 0 && this.refRunIndex !== 0) {
            //        newChangePos = this.imageWidth;
            //        break;
            //    }
            //    if (this.refRun[this.refRunIndex] > curPos) {
            //        newChangePos = this.refRun[this.refRunIndex];
            //        break;
            //    }
            //}
            //return newChangePos;
            ///////////////////////
            // <- REFERENCE CODE //
            ///////////////////////
            if (curPos === 0) {
                return curPosIsWhite ? this.refRun[0] : this.refRun[1];
            }
            var newRefRunIndex = this.refRunIndex;
            // if we are on a white position, we need a black
            // changing element and vice versa
            if (curPosIsWhite) {
                // black changing elements are always at even
                // positions in our list
                if ((newRefRunIndex % 2) === 1) {
                    newRefRunIndex--;
                }
            }
            else {
                // white changing elements are always at odd
                // positions in our list
                if ((newRefRunIndex % 2) === 0) {
                    if (newRefRunIndex > 0) {
                        newRefRunIndex--;
                    }
                    else {
                        newRefRunIndex++;
                    }
                }
            }
            while (newRefRunIndex > 1) {
                if (this.refRun[newRefRunIndex - 2] > curPos) {
                    newRefRunIndex -= 2;
                }
                else {
                    break;
                }
            }
            this.refRunIndex = newRefRunIndex;
            // now go forward till we get one that is after our
            // current position...
            var newChangePos = 0;
            for (; this.refRunIndex < this.refRun.length; this.refRunIndex += 2) {
                if (this.refRun[this.refRunIndex] === 0 && this.refRunIndex !== 0) {
                    newChangePos = this.imageWidth;
                    break;
                }
                if (this.refRun[this.refRunIndex] > curPos) {
                    newChangePos = this.refRun[this.refRunIndex];
                    break;
                }
            }
            return newChangePos;
        };
        G3G4Decoder.prototype.decodeRun = function (runLength) {
            var hPos = (this.a0 - this.passLength);
            var whiteRun = this.isWhite;
            // aways keep our position on the decoding line current
            this.a0 += runLength;
            // if we had a pass element, add it to the runlength
            // all of it will be the same color...
            runLength += this.passLength;
            this.passLength = 0;
            // keep track of the changing element positions...
            this.curRun[this.curRunIndex] = this.a0;
            this.curRunIndex++;
            // switch colors...
            this.isWhite = !this.isWhite;
            if (runLength < 0 || hPos < 0 || hPos > this.imageWidth) {
                throw "Invalid pixel run detected...hPos: " + hPos + ", runLength: " + runLength;
            }
            if (runLength > 0) {
                if (G3G4Helper.decoderDebugOutput) {
                    G3G4Helper.debugLog(hPos + " to " + ((hPos + runLength) - 1) + " " + (whiteRun ? "White" : "Black") + " (" + runLength + ")");
                }
                this.setPixels(this.pixels, hPos, this.rowOffset + this.vPos, runLength, whiteRun);
            }
            else {
                if (G3G4Helper.decoderDebugOutput) {
                    G3G4Helper.debugLog(hPos + " " + (whiteRun ? "White" : "Black") + " Empty");
                }
            }
        };
        G3G4Decoder.prototype.clearArray = function (array, offset, count) {
            for (var i = offset; i < count; i++) {
                array[i] = 0;
            }
        };
        G3G4Decoder.prototype.completeLine = function () {
            // incomplete line data...
            if (this.a0 < this.imageWidth) {
                throw "The data for line " + this.vPos + " is incomplete. " + this.a0 + " pixels provided, " + this.imageWidth + " expected.";
            }
            this.vPos++;
            this.prepareForNextLine();
        };
        G3G4Decoder.prototype.prepareForNextLine = function () {
            // save the current line so we don't lose it...
            var tmpRun = this.refRun;
            // move the current line to the reference line
            this.refRun = this.curRun;
            this.refRunIndex = this.curRunIndex;
            // mark the end of the reference line with 0s
            this.clearArray(this.refRun, this.refRunIndex, this.refRun.length - this.refRunIndex);
            this.refRunIndex = 0;
            // put the old reference line back as the new current
            // line and clear it all out
            this.curRun = tmpRun;
            // clear all entries on the new line...
            this.clearArray(this.curRun, 0, this.curRun.length);
            this.curRunIndex = 0;
            // set our initial state at the beginning of a line
            this.a0 = 0; // right before the first pixel on the line
            this.isWhite = true; // we always start with white pixels
            this.b1 = this.refRun[0]; // the next changing after hPOS is always immediately after the first run-length
            if (G3G4Helper.decoderDebugOutput) {
                G3G4Helper.debugLog(" ");
                G3G4Helper.debugLog("Ready to decode line " + this.vPos + "...");
            }
        };
        G3G4Decoder.prototype.setPixels = function (pixels, x, y, count, setWhite) {
            if (!this.setBlackPixels && !setWhite) {
                return;
            }
            if (!this.setWhitePixels && setWhite) {
                return;
            }
            // make sure we are within the row
            if (x + count > pixels.width) {
                count = pixels.width - x;
            }
            var rowStart = (y * pixels.width * 4);
            var start = rowStart + (x * 4);
            var end = start + (count * 4);
            var bits = pixels.data;
            for (var pidx = start; pidx < end; pidx += 4) {
                bits[pidx] = setWhite ? 0xff : 0x00; //R
                bits[pidx + 1] = setWhite ? 0xff : 0x00; //G
                bits[pidx + 2] = setWhite ? 0xff : 0x00; //B
                bits[pidx + 3] = 0xff; //A
            }
        };
        return G3G4Decoder;
    })();
    NBT.G3G4Decoder = G3G4Decoder;
    ;
    var G3G4Helper = (function () {
        function G3G4Helper() {
        }
        // find the mode we should use based on the number of bits and the value read
        G3G4Helper.lookupMode = function (bitCount, bitValue) {
            if (bitCount > 15 || bitValue > 3) {
                throw "Invalid bit data";
            }
            var tableIndex = ((bitCount & 0xF) << 2) | (bitValue & 0x3);
            return G3G4Helper.decodeModeCodes[tableIndex];
        };
        // finds the decoding information based on the number of bits and the value read
        G3G4Helper.lookupDecode = function (isWhite, bitCount, bitValue) {
            var table = isWhite ? G3G4Helper.decodeMakeUpWhite : G3G4Helper.decodeMakeUpBlack;
            if (bitCount > 15 || bitValue > 255) {
                throw "Invalid bit data";
            }
            var tableIndex = ((bitCount & 0xF) << 8) | (bitValue & 0xFF);
            return table[tableIndex];
        };
        G3G4Helper.debugLog = function (message) {
            if (typeof window.console !== "undefined") {
                window.console.log(message);
            }
        };
        // enable console output during decoder
        G3G4Helper.decoderDebugOutput = false;
        // order in which we handle the bits within a byte
        G3G4Helper.fillOrder_MSBtoLSB = 1;
        G3G4Helper.fillOrder_LSBtoMSB = 2;
        // encoding/decoding modes
        G3G4Helper.mode_Unknown = 0;
        G3G4Helper.mode_Pass = 1;
        G3G4Helper.mode_Horz = 2;
        G3G4Helper.mode_Vert0 = 3;
        G3G4Helper.mode_VertR1 = 4;
        G3G4Helper.mode_VertR2 = 5;
        G3G4Helper.mode_VertR3 = 6;
        G3G4Helper.mode_VertL1 = 7;
        G3G4Helper.mode_VertL2 = 8;
        G3G4Helper.mode_VertL3 = 9;
        G3G4Helper.mode_Ext2D = 10;
        G3G4Helper.mode_Ext1D = 11;
        G3G4Helper.mode_EOL = 12;
        G3G4Helper.code_Unknown = 0;
        G3G4Helper.code_Terminate = 1;
        G3G4Helper.code_MakeUp = 2;
        G3G4Helper.code_AddMakeUp = 3;
        G3G4Helper.code_EOL = 4;
        // mode codes:
        // put the bit count as the high 4 bits and the value as the low 2 for
        // a total of 6 bits in the lookup index
        // ((bitCount & 0xF) << 2) | (bitValue & 0x3);
        G3G4Helper.decodeModeCodes = {
            0x5: G3G4Helper.mode_Vert0,
            0xd: G3G4Helper.mode_Horz,
            0xe: G3G4Helper.mode_VertL1,
            0xf: G3G4Helper.mode_VertR1,
            0x11: G3G4Helper.mode_Pass,
            0x1a: G3G4Helper.mode_VertL2,
            0x1b: G3G4Helper.mode_VertR2,
            0x1d: G3G4Helper.mode_Ext2D,
            0x1e: G3G4Helper.mode_VertL3,
            0x1f: G3G4Helper.mode_VertR3,
            0x25: G3G4Helper.mode_Ext1D,
            0x31: G3G4Helper.mode_EOL
        };
        // decode codes:
        // put the bit count as the high 4 bits and the value as the low 8 for
        // a total of 12 bits for the lookup index
        // ((bitCount & 0xF) << 8) | (bitValue & 0xFF);
        // ct: CodeType, crl: CodeRunLength
        // decoding table for black pixels
        G3G4Helper.decodeMakeUpBlack = {
            0x202: { ct: 1, crl: 3 },
            0x203: { ct: 1, crl: 2 },
            0x302: { ct: 1, crl: 1 },
            0x303: { ct: 1, crl: 4 },
            0x402: { ct: 1, crl: 6 },
            0x403: { ct: 1, crl: 5 },
            0x503: { ct: 1, crl: 7 },
            0x604: { ct: 1, crl: 9 },
            0x605: { ct: 1, crl: 8 },
            0x704: { ct: 1, crl: 10 },
            0x705: { ct: 1, crl: 11 },
            0x707: { ct: 1, crl: 12 },
            0x804: { ct: 1, crl: 13 },
            0x807: { ct: 1, crl: 14 },
            0x918: { ct: 1, crl: 15 },
            0xa08: { ct: 1, crl: 18 },
            0xa0f: { ct: 2, crl: 64 },
            0xa17: { ct: 1, crl: 16 },
            0xa18: { ct: 1, crl: 17 },
            0xa37: { ct: 1, crl: 0 },
            0xb08: { ct: 3, crl: 1792 },
            0xb0c: { ct: 3, crl: 1856 },
            0xb0d: { ct: 3, crl: 1920 },
            0xb17: { ct: 1, crl: 24 },
            0xb18: { ct: 1, crl: 25 },
            0xb28: { ct: 1, crl: 23 },
            0xb37: { ct: 1, crl: 22 },
            0xb67: { ct: 1, crl: 19 },
            0xb68: { ct: 1, crl: 20 },
            0xb6c: { ct: 1, crl: 21 },
            0xc01: { ct: 4, crl: 0 },
            0xc12: { ct: 3, crl: 1984 },
            0xc13: { ct: 3, crl: 2048 },
            0xc14: { ct: 3, crl: 2112 },
            0xc15: { ct: 3, crl: 2176 },
            0xc16: { ct: 3, crl: 2240 },
            0xc17: { ct: 3, crl: 2304 },
            0xc1c: { ct: 3, crl: 2368 },
            0xc1d: { ct: 3, crl: 2432 },
            0xc1e: { ct: 3, crl: 2496 },
            0xc1f: { ct: 3, crl: 2560 },
            0xc24: { ct: 1, crl: 52 },
            0xc27: { ct: 1, crl: 55 },
            0xc28: { ct: 1, crl: 56 },
            0xc2b: { ct: 1, crl: 59 },
            0xc2c: { ct: 1, crl: 60 },
            0xc33: { ct: 2, crl: 320 },
            0xc34: { ct: 2, crl: 384 },
            0xc35: { ct: 2, crl: 448 },
            0xc37: { ct: 1, crl: 53 },
            0xc38: { ct: 1, crl: 54 },
            0xc52: { ct: 1, crl: 50 },
            0xc53: { ct: 1, crl: 51 },
            0xc54: { ct: 1, crl: 44 },
            0xc55: { ct: 1, crl: 45 },
            0xc56: { ct: 1, crl: 46 },
            0xc57: { ct: 1, crl: 47 },
            0xc58: { ct: 1, crl: 57 },
            0xc59: { ct: 1, crl: 58 },
            0xc5a: { ct: 1, crl: 61 },
            0xc5b: { ct: 2, crl: 256 },
            0xc64: { ct: 1, crl: 48 },
            0xc65: { ct: 1, crl: 49 },
            0xc66: { ct: 1, crl: 62 },
            0xc67: { ct: 1, crl: 63 },
            0xc68: { ct: 1, crl: 30 },
            0xc69: { ct: 1, crl: 31 },
            0xc6a: { ct: 1, crl: 32 },
            0xc6b: { ct: 1, crl: 33 },
            0xc6c: { ct: 1, crl: 40 },
            0xc6d: { ct: 1, crl: 41 },
            0xcc8: { ct: 2, crl: 128 },
            0xcc9: { ct: 2, crl: 192 },
            0xcca: { ct: 1, crl: 26 },
            0xccb: { ct: 1, crl: 27 },
            0xccc: { ct: 1, crl: 28 },
            0xccd: { ct: 1, crl: 29 },
            0xcd2: { ct: 1, crl: 34 },
            0xcd3: { ct: 1, crl: 35 },
            0xcd4: { ct: 1, crl: 36 },
            0xcd5: { ct: 1, crl: 37 },
            0xcd6: { ct: 1, crl: 38 },
            0xcd7: { ct: 1, crl: 39 },
            0xcda: { ct: 1, crl: 42 },
            0xcdb: { ct: 1, crl: 43 },
            0xd4a: { ct: 2, crl: 640 },
            0xd4b: { ct: 2, crl: 704 },
            0xd4c: { ct: 2, crl: 768 },
            0xd4d: { ct: 2, crl: 832 },
            0xd52: { ct: 2, crl: 1280 },
            0xd53: { ct: 2, crl: 1344 },
            0xd54: { ct: 2, crl: 1408 },
            0xd55: { ct: 2, crl: 1472 },
            0xd5a: { ct: 2, crl: 1536 },
            0xd5b: { ct: 2, crl: 1600 },
            0xd64: { ct: 2, crl: 1664 },
            0xd65: { ct: 2, crl: 1728 },
            0xd6c: { ct: 2, crl: 512 },
            0xd6d: { ct: 2, crl: 576 },
            0xd72: { ct: 2, crl: 896 },
            0xd73: { ct: 2, crl: 960 },
            0xd74: { ct: 2, crl: 1024 },
            0xd75: { ct: 2, crl: 1088 },
            0xd76: { ct: 2, crl: 1152 },
            0xd77: { ct: 2, crl: 1216 }
        };
        // decoding table for white pixels
        G3G4Helper.decodeMakeUpWhite = {
            0x407: { ct: 1, crl: 2 },
            0x408: { ct: 1, crl: 3 },
            0x40b: { ct: 1, crl: 4 },
            0x40c: { ct: 1, crl: 5 },
            0x40e: { ct: 1, crl: 6 },
            0x40f: { ct: 1, crl: 7 },
            0x507: { ct: 1, crl: 10 },
            0x508: { ct: 1, crl: 11 },
            0x512: { ct: 2, crl: 128 },
            0x513: { ct: 1, crl: 8 },
            0x514: { ct: 1, crl: 9 },
            0x51b: { ct: 2, crl: 64 },
            0x603: { ct: 1, crl: 13 },
            0x607: { ct: 1, crl: 1 },
            0x608: { ct: 1, crl: 12 },
            0x617: { ct: 2, crl: 192 },
            0x618: { ct: 2, crl: 1664 },
            0x62a: { ct: 1, crl: 16 },
            0x62b: { ct: 1, crl: 17 },
            0x634: { ct: 1, crl: 14 },
            0x635: { ct: 1, crl: 15 },
            0x703: { ct: 1, crl: 22 },
            0x704: { ct: 1, crl: 23 },
            0x708: { ct: 1, crl: 20 },
            0x70c: { ct: 1, crl: 19 },
            0x713: { ct: 1, crl: 26 },
            0x717: { ct: 1, crl: 21 },
            0x718: { ct: 1, crl: 28 },
            0x724: { ct: 1, crl: 27 },
            0x727: { ct: 1, crl: 18 },
            0x728: { ct: 1, crl: 24 },
            0x72b: { ct: 1, crl: 25 },
            0x737: { ct: 2, crl: 256 },
            0x802: { ct: 1, crl: 29 },
            0x803: { ct: 1, crl: 30 },
            0x804: { ct: 1, crl: 45 },
            0x805: { ct: 1, crl: 46 },
            0x80a: { ct: 1, crl: 47 },
            0x80b: { ct: 1, crl: 48 },
            0x812: { ct: 1, crl: 33 },
            0x813: { ct: 1, crl: 34 },
            0x814: { ct: 1, crl: 35 },
            0x815: { ct: 1, crl: 36 },
            0x816: { ct: 1, crl: 37 },
            0x817: { ct: 1, crl: 38 },
            0x81a: { ct: 1, crl: 31 },
            0x81b: { ct: 1, crl: 32 },
            0x824: { ct: 1, crl: 53 },
            0x825: { ct: 1, crl: 54 },
            0x828: { ct: 1, crl: 39 },
            0x829: { ct: 1, crl: 40 },
            0x82a: { ct: 1, crl: 41 },
            0x82b: { ct: 1, crl: 42 },
            0x82c: { ct: 1, crl: 43 },
            0x82d: { ct: 1, crl: 44 },
            0x832: { ct: 1, crl: 61 },
            0x833: { ct: 1, crl: 62 },
            0x834: { ct: 1, crl: 63 },
            0x835: { ct: 1, crl: 0 },
            0x836: { ct: 2, crl: 320 },
            0x837: { ct: 2, crl: 384 },
            0x84a: { ct: 1, crl: 59 },
            0x84b: { ct: 1, crl: 60 },
            0x852: { ct: 1, crl: 49 },
            0x853: { ct: 1, crl: 50 },
            0x854: { ct: 1, crl: 51 },
            0x855: { ct: 1, crl: 52 },
            0x858: { ct: 1, crl: 55 },
            0x859: { ct: 1, crl: 56 },
            0x85a: { ct: 1, crl: 57 },
            0x85b: { ct: 1, crl: 58 },
            0x864: { ct: 2, crl: 448 },
            0x865: { ct: 2, crl: 512 },
            0x867: { ct: 2, crl: 640 },
            0x868: { ct: 2, crl: 576 },
            0x998: { ct: 2, crl: 1472 },
            0x999: { ct: 2, crl: 1536 },
            0x99a: { ct: 2, crl: 1600 },
            0x99b: { ct: 2, crl: 1728 },
            0x9cc: { ct: 2, crl: 704 },
            0x9cd: { ct: 2, crl: 768 },
            0x9d2: { ct: 2, crl: 832 },
            0x9d3: { ct: 2, crl: 896 },
            0x9d4: { ct: 2, crl: 960 },
            0x9d5: { ct: 2, crl: 1024 },
            0x9d6: { ct: 2, crl: 1088 },
            0x9d7: { ct: 2, crl: 1152 },
            0x9d8: { ct: 2, crl: 1216 },
            0x9d9: { ct: 2, crl: 1280 },
            0x9da: { ct: 2, crl: 1344 },
            0x9db: { ct: 2, crl: 1408 },
            0xb08: { ct: 3, crl: 1792 },
            0xb0c: { ct: 3, crl: 1856 },
            0xb0d: { ct: 3, crl: 1920 },
            0xc01: { ct: 4, crl: 0 },
            0xc12: { ct: 3, crl: 1984 },
            0xc13: { ct: 3, crl: 2048 },
            0xc14: { ct: 3, crl: 2112 },
            0xc15: { ct: 3, crl: 2176 },
            0xc16: { ct: 3, crl: 2240 },
            0xc17: { ct: 3, crl: 2304 },
            0xc1c: { ct: 3, crl: 2368 },
            0xc1d: { ct: 3, crl: 2432 },
            0xc1e: { ct: 3, crl: 2496 },
            0xc1f: { ct: 3, crl: 2560 }
        };
        return G3G4Helper;
    })();
    NBT.G3G4Helper = G3G4Helper;
})(NBT || (NBT = {}));
//# sourceMappingURL=nbt-ccitt-g3g4.js.map