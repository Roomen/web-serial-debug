// Compile/run on macOS only. Exercises actual close implementation with synthetic channel objects.
#import "../desktop/src-tauri/src/classic/macos.m"
#include <assert.h>
@interface SyntheticChannel : NSObject
@property(nonatomic) int calls;
@property(nonatomic, weak) ClassicChannel *state;
@end
@implementation SyntheticChannel
- (IOReturn)closeChannel { self.calls++; if (self.calls == 2) [self.state rfcommChannelClosed:(id)self]; return kIOReturnNotOpen; }
- (IOReturn)setDelegate:(id)delegate { return kIOReturnSuccess; }
@end
int main(void) {
    @autoreleasepool {
        ClassicChannel *closed=[ClassicChannel new];SyntheticChannel *one=[SyntheticChannel new];closed.channel=(id)one;closed.closed=YES;
        classic_close((__bridge_retained void *)closed);assert(one.calls==0);
        ClassicChannel *overflow=[ClassicChannel new];SyntheticChannel *two=[SyntheticChannel new];overflow.channel=(id)two;overflow.lost=YES;two.state=overflow;
        classic_close((__bridge_retained void *)overflow);assert(two.calls==2);assert(overflow.closed);
    }
    return 0;
}
