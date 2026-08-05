import * as logItem from "../domain/log-item"
import { EventType } from '../domain/event-types'
import { artifactLostFocusThr, editDiffPadding } from '../config/constants';
import { diffLines } from 'diff';

/**
 * 检查是否失焦，用于确定编辑合并边界
 * @param lastLog 上一次日志
 * @param curLog 当前日志
 * @returns 是否失焦
 */
export function lostFocus(lastLog: logItem.LogItem, curLog: logItem.LogItem): boolean {
    if (lastLog.eventType !== EventType.EditTextDocument) { // 之前不在编辑状态，不涉及失焦
        return false
    }
    if (curLog.eventType !== EventType.EditTextDocument &&
        curLog.eventType !== EventType.CursorJump &&
        curLog.eventType !== EventType.CursorJumpAndEdit) { // 离开编辑状态，失焦
        return true
    }
    if (curLog.eventType === EventType.EditTextDocument) { // 还在编辑状态
        // 检查文件名
        if (!lastLog.artifact.equalsByFileName(curLog.artifact)) { // 检查是否离开当前文件
            console.log('lostFocus: lastLog.artifact.equals(curLog.artifact)')
            return true
        }
        if (!lastLog.context || !curLog.context) {
            return true
        }
        if (!lastLog.context?.start.line || !curLog.context?.start.line) {  // 无context的不是正常编辑，默认失焦
            // console.log('lostFocus: lastLog.context?.start.line || !curLog.context?.start.line')
            return true
        }
        if (Math.abs(lastLog.context.start.line - curLog.context.start.line) > artifactLostFocusThr) {  // 编辑位置行号差超过阈值，认为失焦
            // console.log('lostFocus: Math.abs(lastLog.context.start.line - curLog.context.start.line) > artifactLostFocusThr')
            return true
        }
    }
    return false
}

/**
 * 直接获取两段代码的diff行具体内容
 * @param before 修改前的代码
 * @param after 修改后的代码
 * @returns 返回diff行具体内容，每个元素为一行代码
 */
export function getDiffLines(before: string, after: string): string[] {
    const diff = diffLines(before, after).filter(part => part.added || part.removed);
    return diff.map(part => part.value.split('\n')).flat();
}

/**
 * 计算前后代码的diff窗口，并添加标记(Delete, Insert)
 * @description 每行的内容为：<|标记|>(如有) 代码，例如
 * @param before 修改前的代码
 * @param after 修改后的代码
 * @param padding 整段diff的窗口前后保留夺少行代码，默认editDiffPadding
 * @param addLineNumberAfter 是否为输出的每行添加其在after文本中的行号（1-based），默认true。Delete的行不添加行号
 * @returns 
 */
export function getDiffWithMarkers(
    before: string,
    after: string,
    padding: number = editDiffPadding,
    addLineNumberAfter: boolean = true): string {
    // 计算diff
    const diff = diffLines(before, after);

    // 将before按行分割
    const beforeLines = before.split(/\r?\n/);

    // 找到第一个和最后一个有变化的位置
    let firstChangeLine = -1;
    let lastChangeLine = -1;

    let beforeLineIdx = 0;

    // 第一遍遍历：找到变化范围
    for (let i = 0; i < diff.length; i++) {
        const part = diff[i];
        if (part.removed) {
            // 删除的行
            if (firstChangeLine === -1) {
                firstChangeLine = beforeLineIdx;
            }
            lastChangeLine = beforeLineIdx + part.count! - 1;
            beforeLineIdx += part.count!;
        } else if (part.added) {
            // 插入的行
            if (firstChangeLine === -1) {
                firstChangeLine = beforeLineIdx;
            }
            // 插入的行映射到插入位置的行号（插入在beforeLineIdx位置之后）
            lastChangeLine = Math.max(lastChangeLine, beforeLineIdx);
        } else {
            // 未修改的行
            beforeLineIdx += part.count!;
        }
    }

    // 如果没有变化，返回空字符串
    if (firstChangeLine === -1) {
        return "";
    }

    // 根据padding扩展上下文范围
    const startLine = Math.max(0, firstChangeLine - padding);
    const endLine = Math.min(beforeLines.length - 1, lastChangeLine + padding);

    // 第二遍遍历：构建输出
    const result: string[] = [];
    beforeLineIdx = 0;
    let afterLineIdx = 0;  // 追踪在after文本中的行号（0-based）

    for (let i = 0; i < diff.length; i++) {
        const part = diff[i];
        const lines = part.value.split(/\r?\n/);
        // 移除最后一个空行（如果diff结果以换行符结尾）
        if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }

        if (part.removed) {
            // 删除的行：先输出所有删除的行
            const nextPart = i + 1 < diff.length ? diff[i + 1] : null;
            const isFollowedByAdded = nextPart && nextPart.added;

            for (let j = 0; j < lines.length; j++) {
                const lineNum = beforeLineIdx + j;
                if (lineNum >= startLine && lineNum <= endLine) {
                    // Delete的行不添加行号
                    result.push(`<|Delete|>${lines[j]}`);
                }
            }

            // 如果紧接着是插入，处理插入的行
            if (isFollowedByAdded) {
                const addedLines = nextPart!.value.split(/\r?\n/);
                if (addedLines.length > 0 && addedLines[addedLines.length - 1] === '') {
                    addedLines.pop();
                }

                for (let j = 0; j < addedLines.length; j++) {
                    const lineNum = beforeLineIdx;
                    if (lineNum >= startLine && lineNum <= endLine) {
                        const linePrefix = addLineNumberAfter ? `${afterLineIdx + 1} ` : '';
                        result.push(`${linePrefix}<|Insert|>${addedLines[j]}`);
                    }
                    afterLineIdx++;
                }

                // 跳过下一个part（added），因为已经处理了
                i++;
            }

            beforeLineIdx += lines.length;
            // 删除的行不增加afterLineIdx
        } else if (part.added) {
            // 独立的插入（前面没有删除）
            for (let j = 0; j < lines.length; j++) {
                const lineNum = beforeLineIdx;
                if (lineNum >= startLine && lineNum <= endLine) {
                    const linePrefix = addLineNumberAfter ? `${afterLineIdx + 1} ` : '';
                    result.push(`${linePrefix}<|Insert|>${lines[j]}`);
                }
                afterLineIdx++;
            }
            // 注意：插入不增加beforeLineIdx，因为before中没有这些行
        } else {
            // 未修改的行
            for (let j = 0; j < lines.length; j++) {
                const lineNum = beforeLineIdx + j;
                if (lineNum >= startLine && lineNum <= endLine) {
                    const linePrefix = addLineNumberAfter ? `${afterLineIdx + 1} ` : '';
                    result.push(`${linePrefix}${lines[j]}`);
                }
                afterLineIdx++;
            }
            beforeLineIdx += lines.length;
        }
    }

    return result.join('\n');
}


/**
 * 合并一整段编辑事件的首尾两个log，事先已确定处于同一focus下
 * @param firstLog 同一focus下的第一个log
 * @param lastLog 同一focus下的最后一个log
 * @returns 代表该focus的log
 */
function mergeFirstAndLastEditLogs(firstLog: logItem.LogItem, lastLog: logItem.LogItem): logItem.LogItem | null {
    if (!firstLog.context || !lastLog.context) {
        console.error('mergeEdit failed to get context')
        return null
    }
    // 选取范围较小的Artifact作为合并后的Artifact，通常小的Artifact更精确
    const firstArtifactSpan = firstLog.artifact.endPosition() - firstLog.artifact.startPosition()
    const lastArtifactSpan = lastLog.artifact.endPosition() - lastLog.artifact.startPosition()
    const mergedArtifact = firstArtifactSpan > lastArtifactSpan ? lastLog.artifact : firstLog.artifact
    return new logItem.LogItem(
        EventType.EditTextDocument,
        mergedArtifact,
        new logItem.Context(
            firstLog.context.type,
            {
                before: firstLog.context.content.before,
                after: lastLog.context.content.after
            },
            firstLog.context.start,
            lastLog.context.end,),
        lastLog.timeStamp,
    )
}

/**
 * 合并编辑事件，每次添加编辑事件后调用，或需要合并一段log时使用
 * @param logs 原logs数组
 * @returns 合并后的logs数组
 */
export function mergeEditLogs(logs: logItem.LogItem[]): logItem.LogItem[] {
    if (!logs || logs.length === 0) return []

    // 使用双指针正向遍历logs，找到每一个focus编辑块，记录每一个focus块的首尾帧idx
    let firstIdx: number = 0  //指向连续focus编辑事件的开始
    let lastIdx: number = 0  //指向连续focus编辑事件的结束的后一个
    let clsList: Array<{ firstIdx: number, lastIdx: number }> = []
    while (firstIdx < logs.length) {
        // 先找到连续focus编辑事件的开始
        while (firstIdx < logs.length && logs[firstIdx].eventType !== EventType.EditTextDocument) {
            firstIdx++
        }
        lastIdx = firstIdx + 1
        // console.log('mergeEditCluster: firstIdx', firstIdx)

        if (lastIdx >= logs.length) break // 之后没有连续focus编辑事件，退出

        // 再找到连续focus编辑事件的结束
        while (lastIdx < logs.length && !lostFocus(logs[lastIdx - 1], logs[lastIdx])) {
            lastIdx++
        }

        let lastEditIdx = Math.min(lastIdx - 1, logs.length - 1)
        // 再回溯到最后一个Edit事件，防止lastEditLog不是Edit类型的事件
        while (lastEditIdx > firstIdx && logs[lastEditIdx].eventType !== EventType.EditTextDocument) {
            lastEditIdx--
        }

        if (lastEditIdx - firstIdx > 1) {  // 孤立的编辑事件不做合并，因为本身已经是一个focus块
            clsList.push({ firstIdx: firstIdx, lastIdx: lastEditIdx })
        }
        firstIdx = lastIdx
    }
    // console.log('mergeEditCluster: clsList', clsList)
    // console.log('mergeEditCluster: logs', logs)

    // 如果没有需要合并的focus块，直接返回原数组
    if (clsList.length === 0) {
        return logs
    }

    // 构建新的logs数组
    let result: logItem.LogItem[] = []
    let currentIdx = 0

    for (let cluster of clsList) {
        // 添加合并块之前的所有日志
        while (currentIdx < cluster.firstIdx) {
            result.push(logs[currentIdx])
            currentIdx++
        }
        // 合并当前focus块
        const mergedLog = mergeFirstAndLastEditLogs(logs[cluster.firstIdx], logs[cluster.lastIdx])
        if (mergedLog) {
            result.push(mergedLog)
        } else {
            // 如果合并失败，保留原始日志
            for (let i = cluster.firstIdx; i <= cluster.lastIdx; i++) {
                result.push(logs[i])
            }
        }

        // 跳过已合并的日志
        currentIdx = cluster.lastIdx + 1
    }

    // 添加剩余的日志
    while (currentIdx < logs.length) {
        result.push(logs[currentIdx])
        currentIdx++
    }

    return result
}
