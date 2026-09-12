import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  ArrowRight,
  HelpCircle,
  AlertCircle,
  Database,
  Lightbulb,
} from 'lucide-react';
import { useData } from '../../context/DataContext.tsx';
import { api } from '../../lib/api.ts';
import { HistoryItem } from '../../types/index.ts';

interface QuestionInputProps {
  onSubmit: (question: string) => Promise<void>;
  isLoading: boolean;
  loadingStep?: string;
  error?: string | null;
  clarificationQuestion?: string | null;
  clarificationOptions?: string[];
  smartSuggestions?: string[];
}

export function QuestionInput({
  onSubmit,
  isLoading,
  loadingStep = 'Analyzing question...',
  error,
  clarificationQuestion,
  clarificationOptions = [],
  smartSuggestions = [],
}: QuestionInputProps) {
  const { activeDataset, schema } = useData();
  const [question, setQuestion] = useState('');
  const [recentOperations, setRecentOperations] = useState<HistoryItem[]>([]);

  useEffect(() => {
    let isCurrent = true;
    setRecentOperations([]);
    if (!activeDataset) return () => { isCurrent = false; };

    api.history.list(undefined, undefined, 20)
      .then(({ history }) => {
        if (isCurrent) {
          setRecentOperations(history.filter(item =>
            item.dataset_id === activeDataset.id &&
            (item.execution_status === 'completed' || item.status === 'executed')
          ));
        }
      })
      .catch(error => {
        console.warn('Could not load recent suggestions:', error);
      });

    return () => { isCurrent = false; };
  }, [activeDataset?.id]);

  // Prefer completed questions for this database, then fill the four slots from its schema.
  const suggestions = useMemo(() => {
    const result: string[] = [];
    const add = (value: string) => {
      const normalized = value.trim();
      if (normalized && !result.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
        result.push(normalized);
      }
    };

    recentOperations.forEach(operation => add(operation.question));

    if (!schema || schema.tables.length === 0) {
      [
        'How many total records are there?',
        'List all entries ordered by the most recent date',
        'Show the distribution of records by category',
        'What are the top 5 records by the main numeric value?',
      ].forEach(add);
      return result.slice(0, 4);
    }

    const tableNames = schema.tables.map(t => t.name.toLowerCase());

    if (tableNames.includes('marks') || tableNames.includes('students')) {
      [
        'Compare average marks across departments',
        'Count total students in each department',
        'Which students scored above 85 in semester 4?',
        'List the top 5 highest average marks by department',
      ].forEach(add);
    } else {
      const firstTable = schema.tables[0];
      const numCol = firstTable.columns.find(c =>
        /int|numeric|decimal|real|double|float/i.test(c.dataType)
      );
      const textCol = firstTable.columns.find(c =>
        /char|text|uuid/i.test(c.dataType)
      );

      add(`Count total records in ${firstTable.name}`);
      if (textCol && numCol) add(`Average ${numCol.name} grouped by ${textCol.name}`);
      if (textCol) add(`Distribution of entries by ${textCol.name}`);
      if (numCol) add(`List the top 5 ${firstTable.name} by ${numCol.name}`);
    }

    // Keep exactly four visible suggestions even when the schema has few typed columns.
    const tableName = schema.tables[0]?.name || 'this table';
    [
      `Show all records from ${tableName}`,
      `How many records are in ${tableName}?`,
      `Show the first 5 records from ${tableName}`,
      `Summarize the available data in ${tableName}`,
    ].forEach(add);
    return result.slice(0, 4);
  }, [recentOperations, schema]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!question.trim() || isLoading) return;
    onSubmit(question.trim());
  };

  return (
    <div
      id="question-input-card"
      className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 sm:p-8 shadow-sm space-y-5"
    >
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <span>Ask a question about your data</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Querying active scope:{' '}
            <strong className="text-slate-700 dark:text-slate-300">
              {activeDataset ? activeDataset.display_name : 'No dataset selected'}
            </strong>
          </p>
        </div>
      </div>

      {/* Main Form */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <textarea
            id="question-input-textarea"
            rows={3}
            placeholder="e.g. Compare average marks across departments, or show top 5 students by score..."
            value={question}
            onChange={e => setQuestion(e.target.value)}
            disabled={isLoading}
            className="w-full text-sm p-4 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-slate-900 dark:text-white placeholder:text-slate-400 resize-none transition-all disabled:opacity-60"
          />

          <div className="absolute right-3 bottom-3 flex items-center gap-2">
            <button
              id="submit-question-btn"
              type="submit"
              disabled={!question.trim() || isLoading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm shadow-indigo-600/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>{loadingStep}</span>
                </>
              ) : (
                <>
                  <span>Prepare Review</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </div>
      </form>

      {/* Clarification Alert */}
      {clarificationQuestion && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2.5">
          <HelpCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">Clarification required:</p>
            <p className="leading-relaxed">{clarificationQuestion}</p>
            {clarificationOptions.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {clarificationOptions.map(option => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onSubmit(`Show ${option}`)}
                    disabled={isLoading}
                    className="px-2.5 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 text-amber-900 dark:text-amber-200"
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[11px] text-amber-700/80 dark:text-amber-400">
              Please refine your question above with more specifics.
            </p>
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/60 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Unable to formulate valid read-only query</p>
            <p className="leading-relaxed mt-0.5">{error}</p>
            {smartSuggestions.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <p className="font-semibold">Try asking:</p>
                {smartSuggestions.map(suggestion => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => onSubmit(suggestion)}
                    disabled={isLoading}
                    className="block text-left underline hover:no-underline"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Suggested Prompts */}
      <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
          <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
          <span>Suggested analytical inquiries:</span>
        </div>

        <div className="flex flex-wrap gap-2">
          {suggestions.map((s, idx) => (
            <button
              key={idx}
              id={`suggested-question-${idx}`}
              onClick={() => {
                setQuestion(s);
              }}
              disabled={isLoading}
              className="text-left px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/80 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-600 dark:hover:text-indigo-400 border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 transition-colors"
            >
              "{s}"
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
